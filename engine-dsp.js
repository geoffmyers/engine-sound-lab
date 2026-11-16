// Engine sound DSP core. Plain JS with no Web Audio dependency: it runs inside an
// AudioWorklet in the page and directly under Node in the tests.
//
// Signal model, per sample:
//   crank angle advances with rpm (plus compression and per-firing speed ripple)
//   -> each cylinder's firing angle triggers an exhaust blowdown pulse, delayed by its
//      header length, into its bank's stream
//   -> streams merge per the exhaust routing (single collector, X-pipe, true dual)
//   -> turbine damping, catalyst, muffler chamber resonance, tailpipe waveguide
//      (open-end reflection), muffler low-pass, tailpipe radiation
//   + intake pulses through the airbox (Helmholtz) + induction roar
//   + valvetrain clicks, diesel clatter, turbo whistle and blow-off, supercharger whine,
//     starter motor.
// Engine physics (rpm, throttle plate, idle control, limiter, fuel cut, boost, gears)
// update once per render block.

import { TAU, clamp, smoothstep, Rng, Biquad, OnePole, DelayLine, steadyBoostWOT, frictionAt, loadNAAt } from "./dsp-util.js";
import { Drivetrain } from "./drivetrain.js";

const MAX_PULSES = 160;
const EXHAUST_GAIN = 1.0;
const MASTER_GAIN = 1.45;
const SNAPSHOT_SEC = 0.025;
// Octave-band EQ centres for the listener perspective (engine-data.json perspectives[].eqDb).
const EQ_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// Feedback delay network for the perspective's reverb: four mutually prime lengths, in ms.
const FDN_MS = [29.7, 37.1, 41.1, 43.7];

// Pulse kinds
const EXH = 0, INTAKE = 1, CLICK = 2, CLATTER = 3, BLOCK = 4;

export class EngineDSP {
  constructor(sampleRate, seed = 1) {
    this.sr = sampleRate;
    this.rng = new Rng(seed);
    this.time = 0;
    this.cfg = null;

    // Engine state
    this.state = "off";          // off | cranking | running | stopping
    this.rpm = 0;
    this.phi = 0;                // crank angle within the cycle, degrees
    this.thrTarget = 0;          // what the driver asks for, 0..1
    this.thr = 0;                // throttle plate after its lag
    this.idleAir = 0.1;
    this.te = 0; this.load = 0;
    this.boost = 0;              // bar of manifold boost
    this.omega = 0;              // turbo shaft speed, 0..1
    this.mode = "free";          // free | dyno | drive
    this.holdRpm = 0;
    this.sweep = null;
    this.brake = 0; this.ignCut = false;
    this.crankT = 0;
    this.limiterCut = false; this.dfco = false; this.combust = false; this.fuelOn = false; this.starter = 0;
    this.speedBump = 0;
    this.bumpDecay = Math.exp(-1 / (0.08 * sampleRate));
    this.fired = [];
    this.lastSnap = -1;

    // Pulse pool, struct-of-arrays
    this.pAct = new Uint8Array(MAX_PULSES);
    this.pKind = new Uint8Array(MAX_PULSES);
    this.pBank = new Uint8Array(MAX_PULSES);
    this.pDelay = new Int32Array(MAX_PULSES);
    const f = () => new Float32Array(MAX_PULSES);
    this.pAmp = f(); this.pR = f(); this.pRc = f(); this.pD1 = f(); this.pD1c = f();
    this.pD2 = f(); this.pD2c = f(); this.pTail = f(); this.pNoise = f();
    this.pHigh = 0;

    // Exhaust streams (two pipes)
    const maxPipe = Math.ceil(0.05 * sampleRate);
    this.ex = [0, 1].map(() => ({
      turbo: new OnePole(), cat: new OnePole(),
      chDL: new DelayLine(maxPipe), chLP: new OnePole(),
      pipeDL: new DelayLine(maxPipe), pipeLP: new OnePole(),
      muf: new Biquad(), dc: new Biquad(), radPrev: 0,
    }));
    this.helm = new Biquad(); this.roar = new Biquad(); this.raspHP = new Biquad();
    this.clickBP = new Biquad(); this.clatterHP = new Biquad(); this.blockBP = new Biquad(); this.blockLP = new Biquad();
    this.hissBP = new Biquad(); this.bovBP = new Biquad(); this.bovHP = new Biquad();
    this.scNoise = new Biquad(); this.outDC = [new Biquad(), new Biquad()];
    this.whPh = 0; this.scPh = 0; this.stPh = 0; this.flPh = 0;
    // Listener perspective: ground reflection, octave EQ, small reverb (per channel).
    this.eq = [[], []];
    for (let ch = 0; ch < 2; ch++) for (let b = 0; b < EQ_CENTERS.length; b++) this.eq[ch].push(new Biquad());
    this.groundDL = [new DelayLine(Math.ceil(0.03 * sampleRate)), new DelayLine(Math.ceil(0.03 * sampleRate))];
    this.fdn = FDN_MS.map(ms => ({ dl: new DelayLine(Math.ceil(ms / 1000 * sampleRate * 1.6)), lp: new OnePole(), d: ms / 1000 * sampleRate, g: 0 }));
    this.runT = 0;
    this.bovT = 1e9; this.bovStrength = 0; this.bovArmed = 0; this.bovKind = "atmospheric";

    this.script = null; this.scriptIdx = 0;
    this.dt = new Drivetrain(sampleRate, this.rng);
  }

  // ---- control -------------------------------------------------------------------
  handle(msg) {
    switch (msg.type) {
      case "config": this.setConfig(msg.config); break;
      case "control":
        if (msg.throttle !== undefined) this.thrTarget = clamp(msg.throttle, 0, 1);
        if (msg.mode !== undefined) this.setMode(msg.mode);
        if (msg.holdRpm !== undefined) this.holdRpm = msg.holdRpm;
        if (msg.brake !== undefined) this.brake = clamp(msg.brake, 0, 1);
        break;
      case "shift": if (this.mode === "drive") this.dt.request(msg.dir); break;
      case "start": this.start(); break;
      case "stop": this.stop(); break;
    }
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m; this.sweep = null;
    this.dt.reset();
    if (m === "dyno" && this.holdRpm <= 0) this.holdRpm = this.rpm || (this.cfg ? this.cfg.idleRpm : 800);
  }

  start() { if (this.state === "off" || this.state === "stopping") { this.state = "cranking"; this.crankT = 0; } }
  stop() { if (this.state === "running" || this.state === "cranking") this.state = "stopping"; }

  setScript(events) { this.script = events || null; this.scriptIdx = 0; }

  setConfig(cfg) {
    const sr = this.sr;
    this.cfg = cfg;
    const cyc = cfg.cycle;
    const ev = [];
    for (const e of cfg.events) {
      ev.push({ kind: EXH, angle: e.angle % cyc, cyl: e.cyl, bank: e.bank, delay: Math.round(e.delaySec * sr), trim: e.trim, uAmp: e.uAmp ?? 0, uTime: e.uTime ?? 0 });
      ev.push({ kind: INTAKE, angle: (e.angle + cfg.intakeFrac * cyc) % cyc, cyl: e.cyl, bank: e.bank, delay: 0, trim: e.trim, uAmp: e.uAmp ?? 0, uTime: e.uTime ?? 0 });
      if (cfg.valves) {
        // Valve seating clicks: exhaust valve closes, then intake valve closes (385 and 590
        // degrees after firing in a four-stroke's 720).
        ev.push({ kind: CLICK, angle: (e.angle + 0.535 * cyc) % cyc, cyl: e.cyl, bank: e.bank, delay: 0, trim: 1 });
        ev.push({ kind: CLICK, angle: (e.angle + 0.82 * cyc) % cyc, cyl: e.cyl, bank: e.bank, delay: 0, trim: 0.8 });
      }
    }
    ev.sort((a, b) => a.angle - b.angle);
    this.ev = ev;
    this.gap = ev.map((e, i) => {
      const n = ev[(i + 1) % ev.length];
      const g = (n.angle - e.angle + cyc) % cyc;
      return ev.length === 1 ? cyc : g;
    });
    // Re-aim the scheduler at the next event after the current crank angle.
    this.phi %= cyc;
    let idx = ev.findIndex(e => e.angle > this.phi);
    if (idx < 0) idx = 0;
    this.nextIdx = idx;
    this.dist = ((ev[idx].angle - this.phi) + cyc) % cyc || cyc;

    // A different engine or vehicle replaces the old one: start it inside its own speed range
    // (a Wasp handed an S65's 8,000 rpm would crash through idle and read as a stall) and put
    // a new vehicle's gearbox in neutral.
    if (this.state === "running") this.rpm = clamp(this.rpm, cfg.idleRpm, cfg.redline);
    const vehKey = JSON.stringify([cfg.drivetrain.none, cfg.drivetrain.gearboxRatios, cfg.drivetrain.finalDrive, cfg.drivetrain.vehicle]);
    if (vehKey !== this.vehKey) { this.vehKey = vehKey; this.dt.reset(); }
    this.dt.configure(cfg.drivetrain);
    // Propeller load constant: full throttle balances near 95% of the rev limit.
    if (cfg.propeller) {
      const xr = 0.95;
      const tWot = this.torqueShape(xr) * (1 + steadyBoostWOT(cfg.aspiration, cfg.maxBoost, cfg.turboSize, cfg.sc && cfg.sc.type, xr)) * loadNAAt(xr, 1);
      this.propK = Math.max(0, (tWot - frictionAt(xr, 1)) / (xr * xr));
      this.propBP = this.propBP || new Biquad();
    }
    const X = cfg.exhaust;
    for (let i = 0; i < 2; i++) {
      const s = this.ex[i];
      s.cat.set(X.catLpHz, sr);
      s.chLP.set(4200, sr); s.pipeLP.set(2600, sr);
      s.chD = Math.max(1.5, X.chamberDelaySec * sr);
      s.pipeD = Math.max(2, X.pipeDelaySec[i] * sr);
      s.muf.set("lp", X.lpHz, X.lpQ, sr);
      s.dc.set("hp", 24, 0.707, sr);
    }
    const I = cfg.intake;
    this.helm.set("bp", I.helmHz, I.helmQ, sr);
    this.roar.set("bp", I.roarHz, I.roarQ, sr);
    this.raspHP.set("hp", 1600, 0.7, sr);
    this.clickBP.set("bp", 3900, 1.6, sr);
    this.clatterHP.set("hp", 2800, 0.8, sr);
    const BN = cfg.blockNoise;
    if (BN) { this.blockBP.set("bp", BN.centreHz, BN.q, sr); this.blockLP.set("lp", BN.lowpassHz, 0.7, sr); }
    this.bovBP.set("bp", cfg.bov === "recirculating" ? 1300 : cfg.bov === "none" ? 950 : 2300, cfg.bov === "none" ? 1.6 : 0.8, sr);
    this.bovHP.set("hp", cfg.bov === "recirculating" ? 500 : 900, 0.7, sr);
    this.outDC[0].set("hp", 18, 0.707, sr); this.outDC[1].set("hp", 18, 0.707, sr);
    const V = cfg.perspective;
    for (let ch = 0; ch < 2; ch++) EQ_CENTERS.forEach((fc, b) => this.eq[ch][b].set("peak", fc, 1.41, sr, V.eqDb[b] || 0));
    this.groundD = Math.max(1, V.ground.delayMs / 1000 * sr);
    for (const line of this.fdn) {
      // Per-pass gain for the requested RT60, plus high-frequency damping.
      line.g = V.reverb.rt60 > 0 ? Math.pow(10, -3 * (line.d / sr) / V.reverb.rt60) : 0;
      line.lp.set(V.reverb.dampHz || 5000, sr);
    }
    if (this.mode === "dyno" && this.holdRpm <= 0) this.holdRpm = cfg.idleRpm;
  }

  // ---- physics, once per block ---------------------------------------------------
  physics(dt) {
    const c = this.cfg, R = c.redline;
    // Cold start: the ECU holds a fast idle, then drops to the warm idle (measured on the S65).
    if (this.state === "running" || this.state === "cranking") this.runT += dt; else if (this.state === "off") this.runT = 0;
    // Cold start (measured on the S65): idle eases down a curve, and the exhaust is louder
    // while the ECU heats the catalysts with retarded ignition.
    const cs = c.coldStart;
    let idleFactor = 1;
    this.coldness = 0; this.catGain = 1;
    if (cs) {
      const tab = cs.idleCurve, t = this.runT;
      idleFactor = tab[tab.length - 1][1];
      for (let i = 0; i < tab.length - 1; i++) {
        if (t < tab[i + 1][0]) { idleFactor = tab[i][1] + (tab[i + 1][1] - tab[i][1]) * (t - tab[i][0]) / (tab[i + 1][0] - tab[i][0]); break; }
      }
      this.coldness = 1 - smoothstep(cs.catHeatingSec, cs.catHeatingSec + cs.rampSec, t);
      this.catGain = 1 + (Math.pow(10, cs.catHeatingDb / 20) - 1) * this.coldness;
    }
    const idle = c.idleRpm * idleFactor;
    if (this.sweep) {
      const sw = this.sweep, t = clamp((this.time - sw.t0) / sw.dur, 0, 1);
      this.holdRpm = (sw.from + (sw.to - sw.from) * t) * R;
      if (t >= 1) this.sweep = null;
    }
    // The drivetrain sequences shifts first: it may blip or lift the throttle, or cut ignition.
    let pre = null;
    const driving = this.mode === "drive" && !c.drivetrain.none;
    if (driving) {
      this.dt.brake = this.brake;
      pre = this.dt.pre(dt, { rpm: this.rpm, thr: this.thrTarget, idle, redline: R, running: this.state === "running" });
    }
    const target = pre && pre.throttle !== null ? pre.throttle : this.thrTarget;
    this.thr += (target - this.thr) * (1 - Math.exp(-dt / 0.05));
    const x = this.rpm / R;

    let fuelOn = false;
    this.starter = 0;
    if (this.state === "cranking") {
      this.crankT += dt;
      this.starter = 1;
      fuelOn = this.crankT > 0.6;
      if (fuelOn && this.rpm > idle * 0.7) this.state = "running";
    } else if (this.state === "running") {
      fuelOn = true;
      if (this.rpm < idle * 0.25) this.state = "stopping"; // stalled
    }
    this.fuelOn = fuelOn;

    // Idle air control: integral on the idle error, plus a proportional push below idle.
    const idleErr = (idle - this.rpm) / idle;
    if (fuelOn) this.idleAir = clamp(this.idleAir + idleErr * 0.8 * dt, 0, 0.45);
    let te = clamp(this.thr + this.idleAir + Math.max(0, idleErr) * 0.35, 0, 1);
    if (this.mode === "dyno" && this.state === "running") te = clamp(this.thr + 0.06, 0, 1);

    // Rev limiter (hard cut with hysteresis) and deceleration fuel cut-off.
    if (this.rpm > R) this.limiterCut = true;
    else if (this.rpm < R - Math.max(150, R * 0.022)) this.limiterCut = false;
    if (this.thr < 0.03 && this.rpm > idle + 900) this.dfco = true;
    else if (this.thr > 0.05 || this.rpm < idle + 450) this.dfco = false;
    this.ignCut = !!(pre && pre.cut);
    const combust = fuelOn && !this.limiterCut && !this.dfco && !this.ignCut;
    this.combust = combust;

    // Manifold pressure relative to atmosphere: a small plate opening fills the manifold
    // at low rpm but not at high rpm.
    const loadNA = loadNAAt(x, te);
    this.updateBoost(dt, x, te, combust);
    const load = loadNA * (1 + this.boost);
    this.te = te; this.load = load;

    const T = combust ? load * this.torqueShape(x) : 0;
    let F = frictionAt(x, te);
    // A propeller absorbs power with the cube of speed (torque with the square): sized so
    // full throttle settles near 95% of rated rpm, as a fixed-pitch prop does on a run-up.
    if (c.propeller) F += this.propK * x * x;
    const J = c.inertia;

    if (driving && this.state !== "cranking") {
      // Engine and car through the clutch and gearbox (drivetrain.js), in N·m at the crank.
      this.rpm = this.dt.integrate(dt, (T - F * c.drivetrain.frictionScale) * c.drivetrain.Tmax, this.rpm);
    } else {
      let drpm;
      if (this.state === "cranking" && !combust) {
        // Starter motor drags the crank at ~220 rpm against compression.
        drpm = (220 - this.rpm) / 0.12;
      } else if (this.mode === "dyno" && this.state === "running") {
        const tgt = Math.max(this.holdRpm, idle * 0.9);
        drpm = clamp(tgt - this.rpm, -5000 * dt, 5000 * dt) / dt;
      } else {
        drpm = (T - F) * 9000 / J;
        if (this.starter) drpm += 1200;
      }
      this.rpm = Math.max(0, this.rpm + drpm * dt);
      // Free revving: gearbox in neutral, clutch engaged. On a dyno there is no gearbox.
      this.dt.followEngine(this.mode === "dyno" || c.drivetrain.none ? 0 : this.rpm);
    }
    if (this.state === "stopping" && this.rpm < 12) { this.state = "off"; this.rpm = 0; }
    if (this.state === "off") { this.rpm = Math.max(0, this.rpm - 3000 * dt); this.idleAir = 0.1; this.omega *= Math.exp(-dt / 1.5); }
  }

  updateBoost(dt, x, te, combust) {
    const c = this.cfg;
    if (c.aspiration === "turbo") {
      const s = c.turboSize;
      const spool0 = 0.16 + 0.38 * s, spool1 = spool0 + 0.2 + 0.1 * s;
      const flow = combust ? te * smoothstep(spool0, spool1, x * (0.55 + 0.45 * te)) : 0;
      const wTarget = clamp((this.rpm > 0 ? 0.06 : 0) + 0.25 * x * (combust ? 1 : 0.4) + 0.8 * flow, 0, 1);
      const tau = wTarget > this.omega ? 0.25 + 1.3 * s : (this.bovKind === "none" ? 1.0 : 1.5);
      this.omega += (wTarget - this.omega) * (1 - Math.exp(-dt / tau));
      const comp = c.maxBoost * Math.pow(clamp((this.omega - 0.3) / 0.6, 0, 1), 1.2);
      const bTarget = comp * smoothstep(0.1, 0.7, te);
      this.boost += (bTarget - this.boost) * (1 - Math.exp(-dt / (bTarget < this.boost ? 0.05 : 0.12)));
      // Blow-off valve: armed under boost, fires when the throttle snaps shut.
      this.bovKind = c.bov;
      if (this.boost > 0.25 * c.maxBoost && this.thr > 0.45) this.bovArmed = Math.max(this.bovArmed, this.boost / c.maxBoost);
      if (this.bovArmed > 0 && this.thr < 0.22) {
        this.bovT = 0; this.bovStrength = this.bovArmed * (0.4 + 0.6 * this.omega); this.bovArmed = 0;
      }
    } else if (c.aspiration === "supercharger") {
      const bypass = smoothstep(0.12, 0.65, te);
      const bTarget = c.sc.type === "centrifugal" ? c.maxBoost * x * x * bypass : c.maxBoost * (0.75 + 0.25 * x) * bypass;
      this.boost += (bTarget - this.boost) * (1 - Math.exp(-dt / 0.06));
      this.omega = 0;
    } else {
      this.boost = 0; this.omega = 0;
    }
    if (!combust && this.state !== "running") this.boost *= Math.exp(-dt / 0.2);
  }

  // Combustion torque per unit of manifold load at fraction x of the rev limit: the engine's
  // calibrated table (real presets: its published curve), else a generic bell.
  torqueShape(x) {
    const c = this.cfg, tt = c.torqueTable;
    if (tt) {
      const n = tt.base.length, fi = clamp(x / tt.xMax, 0, 1) * (n - 1), i0 = Math.min(n - 2, Math.floor(fi)), f = fi - i0;
      return tt.base[i0] * (1 - f) + tt.base[i0 + 1] * f;
    }
    const peak = c.diesel ? 0.42 : 0.62;
    return clamp(1 - 1.1 * (x - peak) * (x - peak), 0.3, 1);
  }

  // ---- events --------------------------------------------------------------------
  spawn(kind, bank, delay, amp, rise, d1, d2, tail, noise) {
    let k = -1;
    for (let i = 0; i < MAX_PULSES; i++) if (!this.pAct[i]) { k = i; break; }
    if (k < 0) return;
    const sr = this.sr;
    this.pAct[k] = 1; this.pKind[k] = kind; this.pBank[k] = bank; this.pDelay[k] = delay;
    this.pAmp[k] = amp; this.pR[k] = 1; this.pRc[k] = Math.exp(-1 / (rise * sr));
    this.pD1[k] = 1; this.pD1c[k] = Math.exp(-1 / (d1 * sr));
    this.pD2[k] = d2 > 0 ? 1 : 0; this.pD2c[k] = d2 > 0 ? Math.exp(-1 / (d2 * sr)) : 0;
    this.pTail[k] = tail; this.pNoise[k] = noise;
    if (k >= this.pHigh) this.pHigh = k + 1;
  }

  // How far this cylinder's pulse may differ from the others now (physics.loadUnevenness):
  // nothing without combustion, growing with load and, steeply near the limit, with speed.
  unevenness(x, loadN) {
    const U = this.cfg.loadUnevenness;
    if (!U || !this.combust) return null;
    const ramp = Math.pow(clamp((x - U.fromSpeed) / (U.fullSpeed - U.fromSpeed), 0, 1), U.curve ?? 1);
    const w = loadN * ((U.base ?? 0) + (1 - (U.base ?? 0)) * ramp);
    return { amp: U.amp * w, timing: U.timing * w };
  }

  trigger(e, rpm) {
    const c = this.cfg, rng = this.rng;
    const x = rpm / c.redline;
    const Trev = 60 / Math.max(rpm, 60);
    const spin = clamp(rpm / 250, 0, 1); // no pressure to speak of below cranking speed
    if (spin <= 0) return;
    const loadN = Math.min(this.load, 1);

    if (e.kind === EXH) {
      if (this.fired.length < 64) this.fired.push(e.cyl);
      if (this.mode !== "dyno") this.dt.onFiring(rpm, c.redline);
      const idleW = Math.pow(clamp(1 - (x - 0.06) / 0.35, 0, 1), 2);
      let amp;
      if (this.combust) {
        amp = 0.18 + 0.82 * Math.pow(Math.min(this.load, 2.6), 0.85);
        // Combustion varies cycle to cycle, mostly as a slow drift (correlated over several
        // firings) plus a little per-firing jitter; a lumpy cam adds genuinely per-firing misses.
        const cv = c.cycleVariance, rho = cv.correlation;
        const slowSd = cv.slow + (c.coldStart ? c.coldStart.extraVariance * this.coldness : 0);
        this.slowVar = rho * (this.slowVar || 0) + Math.sqrt(1 - rho * rho) * rng.gauss() * slowSd;
        let v = 1 + this.slowVar * idleW + rng.gauss() * (cv.fast + 0.32 * c.camLope * idleW + (c.diesel ? 0.05 : 0));
        if (rng.unit() < c.camLope * 0.2 * idleW) v *= 0.35; // a lazy, overlap-diluted cycle
        amp *= v;
        this.speedBump = clamp(this.speedBump + (v - 1) * 0.035 * (0.3 + idleW), -0.12, 0.12);
      } else {
        amp = 0.07; // pumping air only
      }
      // Gas leaves faster at higher speed: pulse pressure grows with rpm, so the exhaust gets
      // louder with revs rather than just more frequent.
      amp *= c.cylScale * e.trim * spin * Math.pow(0.3 + 0.7 * Math.min(x, 1.05), 0.9) * (this.catGain || 1);
      if (c.aspiration === "turbo") amp *= 1 - 0.3 * this.omega;
      // Cylinder-to-cylinder differences grow with load and speed: at idle the pulses are nearly
      // alike (the real S65 from behind: half orders 30-52 dB down), at full load near the limit
      // they differ enough to put the half orders ~10 dB under the firing order (GT7's recordings).
      let delay = e.delay;
      const uw = this.unevenness(x, loadN);
      if (uw) {
        amp *= 1 + uw.amp * e.uAmp;
        delay = Math.max(0, delay + Math.round(uw.timing * e.uTime * Trev * (c.cycle / 360) / c.events.length * this.sr));
      }
      const Tb = c.blowdownDeg / 360 * Trev;
      const d1 = clamp(Tb / 2.2, 0.00035, 0.009);
      // Blowdown is sharp only when the valve opens against high cylinder pressure: at light
      // load the pulse rises slowly, which is why an idle is dark and a full-throttle pull bright.
      const soft = 1 + 8 * (1 - loadN) * (1 - loadN);
      const rise = (c.rotary ? 0.00007 : 0.00012 + 0.00022 * Math.sqrt(c.cylVol / 0.5)) * soft;
      const d2 = clamp(150 / 360 * Trev * 0.5, 0.0012, 0.03);
      // Turbulent rasp grows with the square of load: an idling engine's pulses are nearly
      // clean (measured: <0.03% of a warm S65 idle's energy is above 500 Hz from behind).
      // Ports snap open: rotaries and two-strokes are raspier and their pulses shorter.
      const portRasp = c.rotary ? 0.35 : (c.twoStroke && !c.valves) ? 0.3 : 0;
      const noise = c.exhaust.rasp * (0.01 + 0.99 * loadN * loadN) * (0.3 + 0.7 * Math.min(x, 1)) + portRasp;
      this.spawn(EXH, e.bank, delay, amp, rise, d1, d2, portRasp ? 0.15 : 0.25, noise);

      // Afterfire: unburnt fuel lighting off in a hot exhaust during fuel cut.
      // An ignition-cut shift (sequential, dual-clutch) crackles the same way.
      // Its level is its own mixer channel (mix.pops), applied here because the pops travel the
      // exhaust path with everything else; the Exhaust channel still scales them on top.
      const popMix = c.mix.pops ?? 0.1;
      if (!this.combust && this.fuelOn && (this.dfco || this.limiterCut || this.ignCut) && c.pops > 0 &&
          rng.unit() < c.pops * (this.dfco ? 0.3 : this.ignCut ? 0.5 : 0.18) * clamp(x * 1.6, 0, 1)) {
        const dly = e.delay + Math.round((0.003 + 0.03 * rng.unit()) * this.sr);
        const pamp = popMix * (0.5 + 0.9 * rng.unit()) * 1.6 * Math.sqrt(c.pops) * Math.pow(c.cylVol / 0.5, 0.25);
        const bank = rng.unit() < 0.5 ? 0 : 1;   // drawn either way, so the mixer never shifts the random sequence
        if (popMix > 0) this.spawn(EXH, bank, dly, pamp, 0.00005, 0.0013, 0.004, 0.12, 1.7);
      }
      const BN = c.blockNoise;
      if (BN && this.combust) {
        const bAmp = BN.level * Math.pow(loadN, BN.loadExp) * (0.25 + 0.75 * Math.min(x, 1)) * c.cylScale * spin;
        this.spawn(BLOCK, 0, 0, bAmp, 0.00004, BN.decayMs / 1000, 0, 0, 1);
      }
      if (c.diesel && this.combust) {
        this.spawn(CLATTER, 0, 0, 0.55 * (1 - 0.5 * loadN) * c.cylScale, 0.00003, 0.0011, 0, 0, 1);
      }
    } else if (e.kind === INTAKE) {
      let amp = -(0.15 + 0.85 * this.te) * (0.35 + 0.65 * Math.min(x, 1)) * c.cylScale * e.trim * spin;
      const Tb = 1.8 * c.blowdownDeg / 360 * Trev;
      // Intake runners differ per cylinder too: the same load- and speed-scaled differences.
      let delay = 0;
      const uw = this.unevenness(x, loadN);
      if (uw) {
        const k = c.loadUnevenness.intakeScale ?? 1;
        amp *= Math.max(0.1, 1 + k * uw.amp * e.uAmp);
        delay = Math.round(0.5 * (1 + e.uTime) * k * uw.timing * Trev * (c.cycle / 360) / c.events.length * this.sr);
      }
      this.spawn(INTAKE, 0, delay, amp, 0.0004, clamp(Tb / 2, 0.0006, 0.012), 0, 0, c.intake.rasp + 0.15);
    } else if (e.kind === CLICK) {
      const amp = 0.05 * (0.5 + 0.5 * Math.min(x, 1)) * (0.8 + 0.4 * rng.unit()) * e.trim * spin;
      this.spawn(CLICK, 0, 0, amp, 0.00002, 0.00045, 0, 0, 1);
    }
  }

  runScript() {
    const sc = this.script;
    while (sc && this.scriptIdx < sc.length && sc[this.scriptIdx][0] <= this.time) {
      const [, kind, a, b, d] = sc[this.scriptIdx++];
      if (kind === "start") this.start();
      else if (kind === "stop") this.stop();
      else if (kind === "throttle") this.thrTarget = a;
      else if (kind === "mode") this.setMode(a);
      else if (kind === "hold") { this.sweep = null; this.holdRpm = a * this.cfg.redline; }
      else if (kind === "sweep") this.sweep = { from: a, to: b, dur: d, t0: this.time };
      else if (kind === "brake") this.brake = a;
      else if (kind === "upshift") this.dt.request("up");
      else if (kind === "downshift") this.dt.request("down");
    }
  }

  // ---- audio ---------------------------------------------------------------------
  process(outL, outR, n) {
    const c = this.cfg;
    if (!c) { outL.fill(0); outR.fill(0); return; }
    const sr = this.sr, dt = n / sr, rng = this.rng;
    this.runScript();
    const rpm0 = this.rpm;
    this.physics(dt);
    const rpm1 = this.rpm;
    const x = rpm1 / c.redline;
    const mix = c.mix, X = c.exhaust;
    const single = X.routing === "single", cf = X.crossfeed;
    // Split pipes carry half the banks each; scale so total radiated power matches one
    // collector (the two banks' pulses are uncorrelated, so their powers add).
    const routeGain = Math.SQRT2 / Math.sqrt(1 + cf * cf);
    const turbo = c.aspiration === "turbo";
    if (turbo) { const fc = 2600 - 1700 * this.omega; this.ex[0].turbo.set(fc, sr); this.ex[1].turbo.set(fc, sr); }

    // Per-block levels for the continuous sources.
    const roarAmp = c.intake.gain * 0.16 * Math.pow(this.te, 1.5) * (0.2 + 0.8 * Math.min(x, 1)) * (this.fuelOn ? 1 : 0.3) * (rpm1 > 50 ? 1 : 0);
    const whF = 1200 + 6800 * Math.pow(this.omega, 1.2);
    const whAmp = turbo ? 0.05 * this.omega * this.omega * (0.25 + 0.75 * clamp(this.boost / Math.max(c.maxBoost, 0.01), 0, 1)) : 0;
    const hissAmp = turbo ? 0.5 * this.omega * this.omega * (0.3 + 0.7 * this.te) : 0;
    if (turbo) this.hissBP.set("bp", 2800 + 3500 * this.omega, 0.9, sr);
    let scF = 0, scAmp = 0;
    if (c.sc) {
      scF = c.sc.pitch === "rpm" ? rpm1 * c.sc.hzPerRpm : rpm1 / 60 * c.sc.ratio * c.sc.lobeFactor;
      const lvl = c.sc.type === "centrifugal" ? x * x : (0.3 + 0.7 * Math.min(x, 1)) * (0.35 + 0.65 * this.te);
      scAmp = c.sc.level * lvl * (rpm1 > 50 ? 1 : 0);
      if (scF > 40) this.scNoise.set("bp", scF, 3, sr);
    }
    const stAmp = this.starter ? 0.07 : 0;
    const mechHum = 0.004 * clamp(rpm1 / 1000, 0, 1);
    const V = c.perspective, src = V.sources;
    const gE = mix.exhaust * EXHAUST_GAIN * X.gain * src.exhaust;
    const gI = mix.intake * src.intake, gM = mix.mechanical * src.mechanical, gInd = mix.induction * src.induction;
    const gBlk = mix.mechanical * (src.block ?? 0), gBlow = mix.induction * (src.blower ?? src.induction);
    const vol = mix.volume * MASTER_GAIN * V.level, w = mix.width * V.width;
    this.dt.blockAudio();
    // Propeller: blade-pass tone and harmonics, and a rasp once the tips near Mach 1.
    let prF = 0, prAmp = 0, prNoise = 0;
    if (c.propeller) {
      const P = c.propeller, propRpm = rpm1 * P.reduction;
      prF = propRpm / 60 * P.blades;
      const tipMach = Math.PI * P.diameterM * propRpm / 60 / 343;
      prAmp = P.level * Math.pow(Math.min(1.1, rpm1 / c.redline), 2);
      prNoise = prAmp * 1.5 * smoothstep(0.6, 0.95, tipMach);
      if (prF > 20) this.propBP.set("bp", Math.min(prF * 6, sr * 0.4), 1.2, sr);
    }
    const gGb = (mix.gearbox ?? 0.5) * src.drivetrain, gRd = (mix.road ?? 0) * src.road, drv = this.dt;
    const gG = V.ground.gain, gD = this.groundD, rvMix = V.reverb.mix, eqL = this.eq[0], eqR = this.eq[1], fdn = this.fdn;
    const cyc = c.cycle, cyl = c.cylinders, ev = this.ev, gap = this.gap, nev = ev.length;
    const ripBase = this.state === "cranking" && !this.combust ? 0.3 : 0.05 * clamp(Math.pow(c.idleRpm / Math.max(rpm1, 1), 2), 0, 1);
    const toRad = Math.PI / 180;
    const harm = c.sc ? c.sc.harmonics : null;
    const bovTau = c.bov === "recirculating" ? 0.22 : c.bov === "none" ? 0.55 : 0.3;
    const bovLvl = c.bov === "recirculating" ? 0.25 : c.bov === "none" ? 0.6 : 0.9;
    const bovDecay = Math.exp(-1 / (bovTau * sr)), bovAtk = Math.exp(-1 / (0.008 * sr));

    for (let i = 0; i < n; i++) {
      const rpmI = rpm0 + (rpm1 - rpm0) * (i / n);
      // Crank speed ripple: compression strokes slow the crank, firings kick it.
      const ripple = 1 + ripBase * Math.sin(TAU * this.phi / cyc * cyl) + this.speedBump;
      this.speedBump *= this.bumpDecay;
      const dphi = Math.max(0, rpmI * ripple) / 60 * 360 / sr;
      this.phi += dphi;
      if (this.phi >= cyc) this.phi -= cyc;
      this.dist -= dphi;
      let guard = 0;
      while (this.dist <= 0 && guard++ < nev) {
        this.trigger(ev[this.nextIdx], rpmI);
        this.dist += gap[this.nextIdx];
        this.nextIdx = (this.nextIdx + 1) % nev;
      }

      // Sum the live pulses.
      const nz = rng.uni();
      let b0 = 0, b1 = 0, inS = 0, clk = 0, clat = 0, blk = 0;
      for (let k = 0; k < this.pHigh; k++) {
        if (!this.pAct[k]) continue;
        if (this.pDelay[k] > 0) { this.pDelay[k]--; continue; }
        const r = this.pR[k], d1 = this.pD1[k], d2 = this.pD2[k];
        const kind = this.pKind[k];
        let v;
        // Exhaust pulses rise in two smooth stages ((1-r)^2): at idle this rolls the harmonics
        // off at the real engine's ~27 dB/octave; at full throttle the rise is too short to matter.
        if (kind === EXH) { const on = (1 - r) * (1 - r); v = this.pAmp[k] * on * (d1 * (1 + this.pNoise[k] * nz) + this.pTail[k] * d2); }
        else if (kind === INTAKE) v = this.pAmp[k] * (1 - r) * (d1 * (1 + this.pNoise[k] * nz) + this.pTail[k] * d2);
        else v = this.pAmp[k] * (1 - r) * d1 * rng.uni();
        this.pR[k] = r * this.pRc[k]; this.pD1[k] = d1 * this.pD1c[k]; this.pD2[k] = d2 * this.pD2c[k];
        if (d1 < 1e-4 && d2 < 1e-4) this.pAct[k] = 0;
        if (kind === EXH) { if (this.pBank[k]) b1 += v; else b0 += v; }
        else if (kind === INTAKE) inS += v;
        else if (kind === CLICK) clk += v;
        else if (kind === BLOCK) blk += v;
        else clat += v;
      }
      while (this.pHigh > 0 && !this.pAct[this.pHigh - 1]) this.pHigh--;

      // Exhaust routing and pipes.
      let s0, s1;
      if (single) { s0 = b0 + b1; s1 = s0; }
      else { s0 = (b0 + cf * b1) * routeGain; s1 = (b1 + cf * b0) * routeGain; }
      const y0 = this.pipe(this.ex[0], s0, turbo, X);
      const y1 = single ? y0 : this.pipe(this.ex[1], s1, turbo, X);

      // Intake: pulses plus roar through the airbox and filter resonances.
      const inX = inS + roarAmp * rng.uni();
      const intake = (this.helm.run(inX) * 1.6 + this.roar.run(inX) * 1.2 + this.raspHP.run(inX) * c.intake.rasp * 0.7) * c.intake.gain;

      // Mechanical: valvetrain clicks, diesel clatter, rotating hum.
      const th = this.phi * toRad;
      const mech = this.clickBP.run(clk) * 2.2 + this.clatterHP.run(clat) * 1.4 +
        mechHum * (Math.sin(th * 2) + 0.6 * Math.sin(th * 4) + 0.25 * Math.sin(th * 2 * 23));
      // Combustion noise radiated by the block and heads: what an engine bay hears whatever the
      // intake, growing with cylinder pressure (load). Its own weight per listening position.
      const block = c.blockNoise ? this.blockLP.run(this.blockBP.run(blk)) : 0;

      // Forced induction.
      let ind = 0;
      if (turbo) {
        this.whPh += whF / sr; if (this.whPh > 1) this.whPh -= 1;
        ind += whAmp * (Math.sin(TAU * this.whPh) + 0.22 * Math.sin(2 * TAU * this.whPh)) + hissAmp * this.hissBP.run(rng.uni());
        if (this.bovT < 3) {
          const t = this.bovT; this.bovT += 1 / sr;
          const env = this.bovStrength * bovLvl * (1 - Math.pow(bovAtk, t * sr)) * Math.pow(bovDecay, t * sr);
          let s = this.bovHP.run(this.bovBP.run(rng.uni()));
          if (c.bov === "none") { // compressor surge flutter
            this.flPh += (13 + 8 * env) / sr; if (this.flPh > 1) this.flPh -= 1;
            s *= this.flPh < 0.45 ? 1 : 0.12;
          }
          ind += env * s;
        }
      }
      if (prAmp > 0 && prF > 1) {
        this.prPh = ((this.prPh || 0) + prF / sr) % 1;
        let s = 0;
        for (let h = 1; h <= 10; h++) if (prF * h < sr * 0.45) s += Math.sin(TAU * this.prPh * h) / Math.pow(h, 0.8);
        ind += prAmp * s + prNoise * this.propBP.run(rng.uni());
      }
      // The supercharger's whine radiates mostly from its inlet: its own weight per listening
      // position (sources.blower), loud at the intake and much quieter in the bay or cabin.
      let blow = 0;
      if (scAmp > 0) {
        this.scPh += scF / sr; if (this.scPh > 1) this.scPh -= 1;
        let s = 0;
        for (let h = 0; h < harm.length; h++) if (scF * (h + 1) < sr * 0.45) s += harm[h] * Math.sin(TAU * this.scPh * (h + 1));
        blow = scAmp * (s * (1 + 0.15 * Math.sin(th)) + 0.8 * this.scNoise.run(rng.uni()));
      }

      // Starter motor: brushed-motor buzz plus pinion whine, loaded by each compression.
      let st = 0;
      if (stAmp > 0) {
        this.stPh += Math.max(rpmI, 40) / 60 * 11 / sr; if (this.stPh > 1) this.stPh -= 1;
        const load = 1 - 0.35 * Math.sin(TAU * this.phi / cyc * cyl);
        st = stAmp * load * (Math.sin(TAU * this.stPh) * 0.6 + Math.sin(TAU * this.stPh * 2) * 0.3 + Math.sin(TAU * this.stPh * 23) * 0.1);
      }

      drv.tick();
      const center = intake * gI + mech * gM + block * gBlk + ind * gInd + blow * gBlow + st + drv.outGear * gGb + drv.outRoad * gRd;
      const mid = (y0 + y1) * 0.5 * gE, side = (y0 - y1) * 0.5 * gE * w;
      let L = mid + side + center, Rr = mid - side + center;
      // Ground reflection: the same sound arriving again a few milliseconds later.
      const gl = this.groundDL[0], gr = this.groundDL[1];
      gl.write(L); gr.write(Rr);
      L += gG * gl.read(gD); Rr += gG * gr.read(gD);
      for (let b = 0; b < eqL.length; b++) { L = eqL[b].run(L); Rr = eqR[b].run(Rr); }
      if (rvMix > 0) {
        // Four-line feedback delay network with a Householder mix.
        const a0 = fdn[0].lp.run(fdn[0].dl.read(fdn[0].d)), a1 = fdn[1].lp.run(fdn[1].dl.read(fdn[1].d));
        const a2 = fdn[2].lp.run(fdn[2].dl.read(fdn[2].d)), a3 = fdn[3].lp.run(fdn[3].dl.read(fdn[3].d));
        const h = 0.5 * (a0 + a1 + a2 + a3), inp = (L + Rr) * 0.25;
        fdn[0].dl.write(inp + fdn[0].g * (a0 - h)); fdn[1].dl.write(inp + fdn[1].g * (a1 - h));
        fdn[2].dl.write(inp + fdn[2].g * (a2 - h)); fdn[3].dl.write(inp + fdn[3].g * (a3 - h));
        L += rvMix * (a0 - a2); Rr += rvMix * (a1 - a3);
      }
      L = this.outDC[0].run(L * vol);
      Rr = this.outDC[1].run(Rr * vol);
      outL[i] = Math.tanh(L);
      outR[i] = Math.tanh(Rr);
    }
    this.time += dt;
  }

  pipe(s, x, turbo, X) {
    if (turbo) x = s.turbo.run(x);
    x = s.cat.run(x);
    // Muffler chamber, then the tailpipe: its open end reflects the wave back inverted.
    const ch = x + X.chamberFeedback * s.chLP.run(s.chDL.read(s.chD));
    s.chDL.write(ch);
    const p = ch - X.pipeFeedback * s.pipeLP.run(s.pipeDL.read(s.pipeD));
    s.pipeDL.write(p);
    const y = s.muf.run(p);
    // A tailpipe radiates roughly the derivative of its flow; blending keeps the bass.
    const rad = y * 0.55 + (y - s.radPrev) * 2.2;
    s.radPrev = y;
    return s.dc.run(rad);
  }

  snapshot(force = false) {
    if (!force && this.time - this.lastSnap < SNAPSHOT_SEC) return null;
    this.lastSnap = this.time;
    const fired = this.fired; this.fired = [];
    return {
      type: "state", time: this.time, rpm: this.rpm, throttle: this.thrTarget, te: this.te, load: this.load,
      boost: this.boost, omega: this.omega, mode: this.mode, ...this.dt.snapshot(),
      state: this.state, limiter: this.limiterCut, dfco: this.dfco, phi: this.phi, fired,
      holdRpm: this.holdRpm,
    };
  }
}
