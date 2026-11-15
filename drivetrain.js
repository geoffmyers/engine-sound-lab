// Drivetrain: clutch, gearbox, final drive, vehicle, brakes, shift sequencing, and the sounds
// they make. Plain JS (AudioWorklet and Node).
//
// Physics, in engine-equivalent units (rad/s at the crank, N·m at the crank):
//   engine   Je·dωe/dt = Te − Tc
//   vehicle   m·dv/dt  = Tc·R/r − drag − rolling − brake          (R = gear × final drive)
//   clutch    Tc = capacity·engagement·clamp(slip / 6 rad/s, −1, 1); it LOCKS when fully
//             engaged with no slip, and then engine and car move as one inertia
//             Je + m(r/R)², unlocking if the torque needed exceeds the clutch's capacity.
//
// Sound, all driven by that state:
//   gear whine at (input-shaft revs) × (mesh events per rev) for the loaded pair, the
//   constant-mesh head set, and the final-drive pinion; straight-cut gears are loud and rich
//   in harmonics, helical ~20 dB quieter and nearly pure; the direct-drive gear has no
//   loaded mesh at all. Gear rattle when the gears spin unloaded (neutral at idle, coasting).
//   Shift sounds: shifter clicks, synchro whirr (pitch follows the shaft being synchronised),
//   engagement clunk, dog-ring clack, driveline shunt when torque reverses. Road and wind.
import { TAU, clamp, Biquad } from "./dsp-util.js";

const RPM = 60 / TAU; // rad/s -> rpm
const MAX_VOICES = 16;

export class Drivetrain {
  constructor(sampleRate, rng) {
    this.sr = sampleRate;
    this.rng = rng;
    this.d = null;
    this.reset();
    this.req = [];
    this.voices = [];
    this.clickBP = new Biquad(); this.rattleBP = new Biquad(); this.syncBP = new Biquad();
    this.roadLP = new Biquad(); this.roadBP = new Biquad(); this.windBP = new Biquad(); this.brakeBP = new Biquad();
    this.phGear = 0; this.phHead = 0; this.phDiff = 0; this.phShaft = 0;
    this.outGear = 0; this.outRoad = 0;
  }

  reset() {
    this.gear = 0; this.v = 0; this.c = 1; this.cTarget = 1; this.cRate = 4; this.locked = false;
    this.shift = null; this.wi = 0; this.Tc = 0; this.lastTc = 0; this.brake = 0; this.refused = null;
    this.dogCap = 1; this.dogCapT = 0; this.cut = false; this.launchArmed = false;
  }

  configure(d) {
    this.d = d;
    // Mesh events per input-shaft revolution for each gear's loaded pair (see engine-data.json
    // drivetrain._gearbox); 0 for a layshaft box's direct-drive gear.
    const gb = d.gearbox;
    this.mesh = d.gearboxRatios.map(r => (gb.layshaft && Math.abs(r - 1) < 1e-6) ? 0 : gb.pairTeethSum / (gb.headRatio + r));
    if (this.gear > d.gearboxRatios.length) this.gear = d.gearboxRatios.length;
    const sr = this.sr;
    this.clickBP.set("bp", 3600, 1.2, sr);
    this.rattleBP.set("bp", 2700, 1.3, sr);
    this.syncBP.set("bp", 2200, 2.5, sr);
    this.roadLP.set("lp", 650, 0.6, sr);
    this.roadBP.set("bp", 1100, 0.9, sr);
    this.windBP.set("bp", 700, 0.5, sr);
    this.brakeBP.set("bp", 3200, 2, sr);
  }

  ratio(g) { return g > 0 ? this.d.gearboxRatios[g - 1] * this.d.finalDrive : 0; }
  wheelW(g) { return this.v / this.d.vehicle.wheelRadiusM * this.ratio(g); }
  gearCount() { return this.d.gearboxRatios.length; }
  request(dir) { if (this.req.length < 2) this.req.push(dir); }

  voice(type, amp, extra = {}) {
    if (amp <= 0) return;
    if (this.voices.length >= MAX_VOICES) this.voices.shift();
    this.voices.push({ type, amp, t: 0, ...extra });
  }

  // ---- shift sequencing, before the engine computes its torque --------------------
  // eng: { rpm, thr (driver), idle, redline, running }. Returns a throttle override (or
  // null) and whether ignition is cut this block.
  pre(dt, eng) {
    const d = this.d, T = d.transmission, N = this.gearCount();
    let throttle = null;
    this.cut = false;

    if (!this.shift && eng.running) {
      if (d.shiftMode === "auto") {
        const A = d.autoShift;
        if (this.gear === 0 && eng.thr > 0.1 && this.v < 1) this.req.push("up");
        // Upshift on ROAD speed (the rpm the wheels imply in this gear), not engine rpm: in
        // a slipping-clutch launch the engine races ahead of the car and would shift at a crawl.
        else if (this.gear > 0 && this.gear < N && Math.min(eng.rpm, this.wheelW(this.gear) * RPM) > A.upAtRedlineFraction * eng.redline && eng.thr > A.upMinThrottle) this.req.push("up");
        // Racing downshifts: the moment the next gear down fits under the redline, take it.
        else if (this.gear > 1 && (eng.thr < A.downMaxThrottle || this.brake > 0.05) &&
                 this.wheelW(this.gear - 1) * RPM < A.downWhenBelowRedlineFraction * eng.redline) this.req.push("down");
      }
      const r = this.req.shift();
      if (r) this.begin(r, eng);
    }

    if (this.shift) {
      const sh = this.shift;
      sh.t += dt;
      const blip = () => (eng.rpm < sh.targetRpm - 120 ? 0.85 : 0.04);
      if (T.kind === "manual") {
        const t1 = T.clutchOut, t2 = t1 + T.lever;
        if (sh.stage === 0) { // clutch out, lift (or blip for a rev-matched downshift)
          this.cTarget = 0; this.cRate = 1 / 0.07;
          if (sh.t >= t1) { sh.stage = 1; this.gear = 0; this.voice("lever", 0.35); }
        } else if (sh.stage === 1 && sh.t >= t2) { // lever reaches the synchro
          sh.stage = 2;
          sh.wFrom = this.wi; sh.wTo = sh.to > 0 ? this.wheelW(sh.to) : this.wi * 0.6;
          const dw = Math.abs(sh.wTo - sh.wFrom);
          sh.syncDur = sh.to > 0 ? T.synchro * (0.4 + 0.6 * Math.min(1, dw / 300)) : 0.02;
          sh.syncT = 0;
          if (sh.to > 0) this.voice("synchro", Math.min(1, dw / 250), { dur: sh.syncDur, f0: 1500 + Math.min(dw, 600) * 2.5 });
        } else if (sh.stage === 2) { // synchronising: the input shaft is dragged to the new speed
          sh.syncT += dt;
          const k = Math.min(1, sh.syncT / sh.syncDur);
          this.wi = sh.wFrom + (sh.wTo - sh.wFrom) * k;
          if (k >= 1) {
            sh.stage = 3; this.gear = sh.to;
            if (sh.to > 0) this.voice("clunk", 0.55); else this.voice("lever", 0.3);
            this.cTarget = 1; this.cRate = 1 / T.clutchIn;
          }
        } else if (sh.stage === 3 && this.c >= 0.97) { this.shift = null; }
        if (this.shift && sh.stage < 3) throttle = sh.dir === "down" && d.revMatch && sh.to > 0 ? blip() : 0;
      } else if (T.kind === "sequential") {
        if (sh.dir === "up") { // flat shift: ignition cut, the dog ring slams across
          this.cut = sh.t < T.cut;
          if (!sh.done && sh.t >= T.cut * 0.4) { sh.done = true; this.gear = sh.to; this.locked = false; this.dogCap = 3; this.voice("dog", 0.9); }
          if (sh.t >= T.cut) { this.shift = null; this.dogCap = 1; }
        } else { // auto-blip with the gear out, then the dog ring goes in
          if (!sh.out) { sh.out = true; this.gear = 0; this.voice("lever", 0.25); }
          throttle = blip();
          if (sh.to === 0 || eng.rpm >= sh.targetRpm - 150 || sh.t >= T.blip) {
            this.gear = sh.to; this.locked = false; this.dogCap = 3;
            if (sh.to > 0) this.voice("dog", 0.8);
            this.shift = null; this.dogCapT = 0.08;
          }
        }
      } else { // dual-clutch
        if (sh.dir === "up") {
          this.cut = sh.t < T.cut;
          if (!sh.done) { sh.done = true; this.gear = sh.to; this.locked = false; this.c = 0.35; this.cTarget = 1; this.cRate = 1 / T.handover; this.voice("clunk", 0.15); }
          if (sh.t >= T.handover) this.shift = null;
        } else {
          if (!sh.out) { sh.out = true; this.cTarget = 0; this.cRate = 1 / 0.04; }
          throttle = blip();
          if (sh.to === 0 || eng.rpm >= sh.targetRpm - 150 || sh.t >= T.blip) {
            this.gear = sh.to; this.locked = false; this.c = 0.3; this.cTarget = 1; this.cRate = 1 / T.handover;
            if (sh.to > 0) this.voice("clunk", 0.2);
            this.shift = null;
          }
        }
      }
    }
    if (this.dogCapT > 0) { this.dogCapT -= dt; if (this.dogCapT <= 0) this.dogCap = 1; }

    // Clutch automation: launch from rest, and never stall in gear.
    if (!this.shift) {
      if (this.gear === 0) { this.cTarget = 1; this.cRate = 4; }
      else if (!eng.running) this.cTarget = 0;
      else if (this.cTarget >= 1 && ((eng.rpm < eng.idle * 0.8 && eng.thr < 0.25) || eng.rpm < eng.idle * 0.55)) {
        this.cTarget = 0; this.cRate = 1 / 0.07; // never stall: the clutch lets go first
      }
      else if (this.cTarget <= 0 && (eng.thr > 0.05 || this.wheelW(this.gear) * RPM > eng.idle * 1.15)) {
        this.cTarget = 1; this.cRate = 1 / T.launch;
      }
    }
    const rate = this.cRate || 4;
    this.c = clamp(this.c + clamp(this.cTarget - this.c, -rate * dt, rate * dt), 0, 1);
    // Two-pedal launch control: brake and full throttle at rest hold the clutch open and the
    // engine at its launch speed; releasing the brake launches.
    if (!this.shift && this.gear > 0 && this.v < 0.5 && this.brake > 0.5 && eng.thr > 0.5 && eng.running) {
      this.launchArmed = true; this.cTarget = 0; this.c = 0;
      const launch = eng.idle + (0.5 * eng.redline - eng.idle) * eng.thr;
      throttle = eng.rpm < launch ? 1 : 0.05;
    } else if (this.launchArmed && this.brake <= 0.5) {
      this.launchArmed = false; this.cTarget = 1; this.cRate = 1 / this.d.transmission.launch;
    }
    // Launch control: while pulling away the clutch slips to hold the engine near a launch
    // speed (higher with more throttle) and only locks once road speed catches up. A Top
    // Fuel car's single ratio needs this for most of its run; every launch uses some.
    if (!this.shift && this.gear === 1 && !this.locked && this.cTarget >= 1 && eng.running && eng.thr > 0.05) {
      const launch = eng.idle + (0.5 * eng.redline - eng.idle) * eng.thr;
      if (eng.rpm < launch && this.wheelW(1) * RPM < launch) this.c = Math.max(0.03, this.c - dt * 20 * (launch - eng.rpm) / launch);
    }
    return { throttle, cut: this.cut };
  }

  begin(dir, eng) {
    const N = this.gearCount();
    const to = this.gear + (dir === "up" ? 1 : -1);
    if (to < 0 || to > N) return;
    const targetRpm = to > 0 ? this.wheelW(to) * RPM : eng.idle;
    if (to > 0 && targetRpm > eng.redline * 1.03) {
      this.refused = `Too fast for ${to === 1 ? "1st" : to === 2 ? "2nd" : to === 3 ? "3rd" : to + "th"} gear: it would rev to ${Math.round(targetRpm).toLocaleString("en-US")} rpm`;
      return;
    }
    if (this.gear === 0 && to === 1 && this.v < 1) {
      // Into first at rest: lever in, then let the clutch out.
      this.gear = 1; this.c = 0; this.cTarget = eng.thr > 0.05 ? 1 : 0; this.cRate = 1 / this.d.transmission.launch;
      this.voice("lever", 0.3); this.voice("clunk", 0.25);
      return;
    }
    this.shift = { dir, to, t: 0, stage: 0, targetRpm };
  }

  // ---- physics, after the engine has its torque ------------------------------------
  // Te: engine net torque at the crank (N·m). Returns the new engine rpm.
  integrate(dt, Te, rpm) {
    const d = this.d, V = d.vehicle, m = V.massKg, r = V.wheelRadiusM, Je = d.Je;
    let we = rpm / RPM;
    const sub = 4, h = dt / sub;
    const Tc0 = this.Tc;
    for (let s = 0; s < sub; s++) {
      const v = this.v;
      const moving = v > 0.01;
      const Fres = (moving ? 0.6 * V.cdA * v * v + V.crr * m * 9.81 : 0) + (moving ? this.brake * m * V.brakeDecel : 0);
      const g = this.gear, R = this.ratio(g);
      // What reaches the road is limited only by the clutch. The tyres have full traction (a
      // deliberate simplification): no wheelspin, no wheelies, every newton the clutch passes
      // moves the car.
      const cap = d.clutchCapacity * this.c * this.dogCap;
      if (g === 0 || this.c <= 0.001) {
        this.locked = false; this.Tc = 0;
        we = Math.max(0, we + Te / Je * h);
        this.v = Math.max(0, v - Fres / m * h);
        continue;
      }
      if (this.locked) {
        const Jeq = Je + m * (r / R) * (r / R);
        const dw = (Te - Fres * r / R) / Jeq;
        const Tc = Te - Je * dw;
        if (Math.abs(Tc) <= cap * 1.02 && this.c >= 0.98) {
          we = Math.max(0, we + dw * h);
          this.v = we / R * r; this.Tc = Tc;
          continue;
        }
        this.locked = false;
      }
      const slip = we - v / r * R;
      const Tc = cap * clamp(slip / 6, -1, 1);
      we = Math.max(0, we + (Te - Tc) / Je * h);
      this.v = Math.max(0, v + (Tc * R / r - Fres) / m * h);
      this.Tc = Tc;
      if (this.c >= 0.98 && Math.abs(we - this.v / r * R) < 2) this.locked = true;
    }
    // Driveline shunt: torque through the gears reverses sharply (on/off throttle, a shift).
    if (this.gear > 0 && Math.sign(this.Tc) !== Math.sign(Tc0) && Math.abs(this.Tc - Tc0) > 0.2 * d.Tmax) {
      this.voice("shunt", Math.min(1, Math.abs(this.Tc - Tc0) / d.Tmax) * 0.6);
    }
    // The input shaft (clutch disc and gearbox input): tied to the wheels in gear, to the
    // engine in neutral with the clutch in, else spinning down. Synchro shifts set it directly.
    if (!(this.shift && this.shift.stage === 2)) {
      if (this.gear > 0) this.wi = this.wheelW(this.gear);
      else if (this.c > 0.3) this.wi = we;
      else this.wi *= Math.exp(-dt / 1.5);
    }
    return we * RPM;
  }

  // Free-rev mode: no car, gearbox in neutral, clutch engaged.
  followEngine(rpm) { this.gear = 0; this.v = 0; this.c = 1; this.cTarget = 1; this.Tc = 0; this.shift = null; this.wi = rpm / RPM; }

  // A firing event: unloaded gears rattle against their backlash when the crank speed jerks.
  onFiring(rpm, redline) {
    const d = this.d;
    if (this.wi < 20 || this.c < 0.5) return;
    const unloaded = clamp(1 - Math.abs(this.Tc) / (0.06 * d.Tmax), 0, 1);
    const lowRev = clamp(1 - rpm / (0.5 * redline), 0, 1);
    const p = unloaded * lowRev;
    if (p > 0.02 && this.rng.unit() < 0.7) this.voice("rattle", d.gearCut.rattle * p * (0.5 + this.rng.unit()));
  }

  // ---- audio ---------------------------------------------------------------------
  blockAudio() {
    const d = this.d, gc = d.gearCut, gb = d.gearbox, sr = this.sr;
    const g = this.gear, shaftHz = this.wi / TAU;
    const loaded = g > 0 && this.c > 0.5;
    const load = loaded ? 0.25 + Math.min(1.5, Math.abs(this.Tc) / d.Tmax) : 0.1;
    const speed = Math.min(1.3, this.wi / 600);
    const coast = this.Tc < 0 ? 0.8 : 1;
    const direct = g > 0 && this.mesh[g - 1] === 0;
    this.fGear = g > 0 ? shaftHz * this.mesh[g - 1] : 0;
    this.fHead = shaftHz * gb.headMeshPerRev;
    this.fShaft = shaftHz;
    this.aGear = this.fGear > 0 ? gc.whine * load * speed * coast : 0;
    this.aHead = gb.headMeshPerRev > 0 ? gc.whine * 0.6 * (direct ? 0.1 : load) * speed * coast : 0;
    const wheel = this.v / d.vehicle.wheelRadiusM;
    this.fDiff = wheel * d.finalDrive / TAU * gb.pinionTeeth;
    this.aDiff = gb.pinionTeeth <= 0 ? 0 : d.diffLevel * (0.3 + Math.min(1, Math.abs(this.Tc) / d.Tmax)) * Math.min(1, this.v / 40);
    this.aRoad = d.roadLevel * Math.pow(this.v / 30, 1.3);
    this.aWind = d.windLevel * Math.pow(this.v / 40, 2.5);
    this.aBrake = 0.012 * this.brake * Math.min(1, this.v / 8);
    this.harm = gc.harmonics;
    this.nyq = sr * 0.45;
    const sv = this.voices.find(v => v.type === "synchro");
    if (sv) this.syncBP.set("bp", sv.f0 * (1 - 0.4 * Math.min(1, sv.t / sv.dur)), 2.5, sr);
  }

  tick() {
    const sr = this.sr, rng = this.rng, H = this.harm;
    let whine = 0;
    if (this.aGear > 0 || this.aHead > 0) {
      this.phGear += this.fGear / sr; this.phGear -= Math.floor(this.phGear);
      this.phHead += this.fHead / sr; this.phHead -= Math.floor(this.phHead);
      this.phShaft += this.fShaft / sr; this.phShaft -= Math.floor(this.phShaft);
      // Tooth-spacing errors repeat once per shaft turn: amplitude sidebands.
      const am = 1 + 0.2 * Math.sin(TAU * this.phShaft);
      for (let k = 0; k < H.length; k++) {
        if (this.fGear * (k + 1) < this.nyq) whine += this.aGear * H[k] * Math.sin(TAU * this.phGear * (k + 1));
        if (this.fHead * (k + 1) < this.nyq) whine += this.aHead * H[k] * Math.sin(TAU * this.phHead * (k + 1));
      }
      whine *= am;
    }
    if (this.aDiff > 0 && this.fDiff < this.nyq) {
      this.phDiff += this.fDiff / sr; this.phDiff -= Math.floor(this.phDiff);
      whine += this.aDiff * Math.sin(TAU * this.phDiff);
    }

    let click = 0, rattle = 0, sync = 0, thump = 0;
    const vs = this.voices;
    for (let i = vs.length - 1; i >= 0; i--) {
      const v = vs[i], t = v.t;
      v.t += 1 / sr;
      const n = rng.uni();
      switch (v.type) {
        case "lever": click += v.amp * 0.25 * n * Math.exp(-t / 0.0025); if (t > 0.02) vs.splice(i, 1); break;
        case "rattle": rattle += v.amp * n * Math.exp(-t / 0.0015); if (t > 0.012) vs.splice(i, 1); break;
        case "clunk":
          thump += v.amp * 0.5 * Math.sin(TAU * 85 * t) * Math.exp(-t / 0.045);
          click += v.amp * 0.6 * n * Math.exp(-t / 0.004);
          if (t > 0.3) vs.splice(i, 1);
          break;
        case "dog":
          thump += v.amp * 0.6 * Math.sin(TAU * 70 * t) * Math.exp(-t / 0.05);
          click += v.amp * 1.4 * n * Math.exp(-t / 0.007) + v.amp * 0.3 * Math.sin(TAU * 3150 * t) * Math.exp(-t / 0.03);
          if (t > 0.3) vs.splice(i, 1);
          break;
        case "shunt": thump += v.amp * 0.7 * Math.sin(TAU * 55 * t) * Math.exp(-t / 0.08); if (t > 0.5) vs.splice(i, 1); break;
        case "synchro": {
          const env = Math.min(1, t / 0.01) * (t < v.dur ? 1 : Math.exp(-(t - v.dur) / 0.02));
          sync += v.amp * 0.5 * env * n * (0.6 + 0.4 * Math.sin(TAU * 140 * t));
          if (t > v.dur + 0.12) vs.splice(i, 1);
          break;
        }
      }
    }
    this.outGear = whine + this.clickBP.run(click) * 0.8 + this.rattleBP.run(rattle) * 1.5 + this.syncBP.run(sync) + thump * 0.35;

    let road = 0;
    if (this.aRoad > 1e-6 || this.aWind > 1e-6 || this.aBrake > 0) {
      const n1 = rng.uni(), n2 = rng.uni();
      road = this.aRoad * (this.roadLP.run(n1) * 2 + this.roadBP.run(n1) * 0.6) + this.aWind * this.windBP.run(n2) * 2 + this.aBrake * this.brakeBP.run(n2);
    }
    this.outRoad = road;
  }

  snapshot() {
    const refused = this.refused; this.refused = null;
    return { gear: this.gear, speedKmh: this.v * 3.6, clutch: this.c, shifting: !!this.shift, brake: this.brake, refused };
  }
}
