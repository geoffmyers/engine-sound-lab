import { steadyBoostWOT, frictionAt, loadNAAt } from "./dsp-util.js";

// Resolves the user's settings (a preset plus edits) and engine-data.json into the plain
// numbers the DSP runs on. Pure: no DOM, no Web Audio, so the page and the Node tests share it.

// A deterministic 0..1 value per cylinder, so "unequal headers" sound the same every time.
function hash01(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

// A preset can give its engine's real firing order and bank numbering ("firingOrder",
// "banks"): the cylinders are then laid onto the layout's firing angles in that order. Two
// cross-plane V8s with different orders put different patterns into each bank's pipe.
export function layoutInfo(data, layoutId, s) {
  const base = data.layouts[layoutId];
  if (!base) throw new Error(`Unknown layout ${layoutId}`);
  let L = base;
  if (s && Array.isArray(s.firingOrder) && s.firingOrder.length === base.firing.length) {
    const angles = [...base.firing].sort((a, b) => a[1] - b[1]).map(f => f[1]);
    const inBank1 = new Set((s.banks && s.banks["1"]) || []);
    L = { ...base, firing: s.firingOrder.map((cyl, i) => [cyl, angles[i], inBank1.has(cyl) ? 1 : 0]) };
  }
  const cylinders = L.firing.length;
  const banks = new Set(L.firing.map(f => f[2])).size;
  const sorted = [...L.firing].sort((a, b) => a[1] - b[1]);
  const intervals = sorted.map((f, i) => {
    const next = sorted[(i + 1) % sorted.length];
    return ((next[1] - f[1] + L.cycle) % L.cycle) || L.cycle;
  });
  // Per-bank intervals show why a cross-plane V8 burbles: each bank alone fires unevenly.
  const bankIntervals = [];
  for (let b = 0; b < banks; b++) {
    const own = sorted.filter(f => f[2] === b);
    bankIntervals.push(own.map((f, i) => {
      const next = own[(i + 1) % own.length];
      return ((next[1] - f[1] + L.cycle) % L.cycle) || L.cycle;
    }));
  }
  return {
    ...L, id: layoutId, cylinders, banks,
    order: sorted.map(f => f[0]),
    intervals, bankIntervals,
    eventsPerRev: cylinders * 360 / L.cycle,
    rotary: L.family === "rotary",
    twoStroke: L.strokes === 2,
    // Poppet valves click; ports and rotors do not (a Detroit two-stroke has exhaust valves).
    valves: L.valves ?? (L.family !== "rotary" && L.strokes !== 2),
  };
}

// Firing frequency in Hz: how many combustion events per second at this speed.
export function firingHz(info, rpm) {
  return rpm / 60 * info.eventsPerRev;
}

// A listener position: source balance, ground reflection, octave EQ, reverb, width, level.
export function resolvePerspective(data, id) {
  const V = data.perspectives[id] || data.perspectives[data.defaults.perspective];
  return {
    sources: { exhaust: 1, intake: 1, mechanical: 1, induction: 1, drivetrain: 1, road: 1, ...V.sources },
    eqDb: V.eqDb || [], ground: V.ground || { delayMs: 3, gain: 0 },
    reverb: V.reverb || { mix: 0, rt60: 0 }, width: V.width ?? 1, level: V.level ?? 1,
  };
}

// Monotone cubic (PCHIP) through points [[x, y], ...]: no overshoot between published points.
function pchip(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export const TORQUE_TABLE_X = 1.3;   // the table runs to 130% of the rev limit
export const TORQUE_TABLE_N = 131;

// Full-throttle crank torque (N·m) at a given rpm, through the engine's published points:
// low-speed torque, peak torque at its rpm, the torque implied by peak power at its rpm, a
// fall-off that keeps power just under its peak at the limiter, and a steep drop beyond.
export function wotTorqueCurve(s) {
  const T = s.torque, R = s.redline;
  const w = (rpm) => rpm * 2 * Math.PI / 60;
  const Tp = T.powerKw * 1000 / w(T.powerRpm);
  const lowFrac = s.aspiration === "turbo" ? (s.fuel === "diesel" ? 0.4 : 0.45)
    : s.aspiration === "supercharger" ? (s.scType === "centrifugal" ? 0.5 : 0.8) : 0.65;
  // A governed engine (a mower) can peak at or below its running speed: peak at idle then.
  const peakAtIdle = T.peakRpm <= s.idleRpm + 50;
  const pts = [[0, T.peakNm * lowFrac * 0.85], [s.idleRpm, peakAtIdle ? T.peakNm : T.peakNm * lowFrac]];
  if (!peakAtIdle) pts.push([T.peakRpm, T.peakNm]);
  if (T.powerRpm > T.peakRpm + 50) pts.push([T.powerRpm, Tp]);
  const last = pts[pts.length - 1][0];
  if (R > last + 50) pts.push([R, 0.95 * T.powerKw * 1000 / w(R)]);
  pts.push([R * TORQUE_TABLE_X, pts[pts.length - 1][1] * 0.55]);
  pts.sort((a, b) => a[0] - b[0]);
  return pchip(pts.filter((p, i) => i === 0 || p[0] > pts[i - 1][0]));
}

// The DSP's normalized torque base(x): load x base gives combustion torque in units of
// Tunit (the published peak). Full-throttle boost and friction are divided back out, so at
// steady full throttle the net crank torque equals the published curve, while turbo lag and
// part throttle still act through the load.
function torqueTable(s, frictionScale) {
  if (!s.torque) return null;
  const curve = wotTorqueCurve(s), Tunit = s.torque.peakNm;
  const maxBoost = s.aspiration === "na" ? 0 : (s.boost ?? 1);
  const base = [];
  for (let i = 0; i < TORQUE_TABLE_N; i++) {
    const x = i / (TORQUE_TABLE_N - 1) * TORQUE_TABLE_X;
    const b = steadyBoostWOT(s.aspiration, maxBoost, s.turboSize ?? 0.5, s.scType, x);
    base.push((curve(x * s.redline) / Tunit + frictionAt(x, 1) * frictionScale) / ((1 + b) * loadNAAt(x, 1)));
  }
  return { base, Tunit, xMax: TORQUE_TABLE_X };
}

// An aircraft engine turns a propeller: it loads the engine with the square of speed and
// its blades make a tone at prop rpm x blades.
function propellerConfig(s) {
  const P = s.propeller;
  if (!P) return null;
  return { blades: P.blades, reduction: P.reduction ?? 1, diameterM: P.diameterM ?? 2.5, level: P.level ?? 0.05 };
}

// Gearbox, clutch and car. Torque is scaled from displacement so the free-revving engine
// behaves exactly as before: Je = Tmax·inertia·60/(2π·9000).
function buildDrivetrain(data, s) {
  const D = data.drivetrain;
  const none = s.vehicle === "none";
  const veh = (!none && D.vehicles[s.vehicle]) || D.vehicles.car;
  const geometry = typeof veh.gearbox === "string" ? D.gearboxGeometries[veh.gearbox] : veh.gearbox;
  // Torque unit: the published peak for real engines, else a per-litre estimate.
  const Tmax = s.torque ? s.torque.peakNm : D.torquePerLitreNm * s.displacement;
  const boost = s.aspiration === "na" || s.torque ? 0 : (s.boost ?? 1);
  return {
    torquePerLitreNm: D.torquePerLitreNm, frictionScale: D.driveFrictionScale, diffLevel: D.diffLevel, roadLevel: D.roadLevel, windLevel: D.windLevel,
    none, // no wheels: a chainsaw, a mower, an aircraft engine
    vehicle: veh.vehicle, gearboxRatios: veh.gearboxRatios, finalDrive: veh.finalDrive, gearbox: geometry,
    transmission: { ...data.transmissions[s.transmission || "manual"] },
    gearCut: { ...data.gearCuts[s.gearCut || "helical"] },
    shiftMode: s.shiftMode || "auto",
    autoShift: { ...data.autoShift },
    revMatch: s.revMatch ?? true,
    Tmax,
    Je: Tmax * s.inertia * 60 / (2 * Math.PI * 9000),
    clutchCapacity: D.clutchCapacityFactor * Tmax * (1 + boost),
  };
}

export function buildConfig(data, s) {
  const info = layoutInfo(data, s.layout, s);
  const P = data.physics;
  const muffler = data.mufflers[s.muffler];
  const intake = data.intakes[s.intake];
  const c = P.speedOfSoundExhaust;
  const cylVol = s.displacement / info.cylinders;

  // Header (runner) length per cylinder sets when its pulse reaches the collector.
  const perBankIndex = {};
  const events = info.firing.map(([cyl, angle, bank]) => {
    const k = (perBankIndex[bank] = (perBankIndex[bank] ?? -1) + 1);
    let len = P.headerLengthM;
    if (s.headers === "unequal") len += (hash01(cyl * 7 + 3) - 0.35) * P.unequalHeaderSpreadM * 2;
    if (s.headers === "log") len = 0.25 + k * P.logManifoldStepM;
    return {
      cyl, angle, bank,
      delaySec: Math.max(0.05, len) / c,
      trim: 1 + (hash01(cyl * 13 + 1) - 0.5) * P.cylinderTrimSpread, // no two cylinders burn exactly alike
      // Under load each cylinder's pulse also differs in strength and arrival (runner waves,
      // breathing, mixture): fixed per cylinder, scaled at run time by load and speed.
      uAmp: hash01(cyl * 29 + 5) * 2 - 1,
      uTime: hash01(cyl * 31 + 11) * 2 - 1,
    };
  });

  // The per-cylinder differences, read in firing order, carry none of the slowest patterns (once
  // or twice per cycle): those put their energy in the lowest half orders, below where real
  // engines' half orders sit (Gran Turismo's recordings: the 63 Hz octave from behind came out
  // up to 9 dB high with them). The pattern keeps its overall size.
  const lowOrders = P.loadUnevenness?.removeLowOrders ?? 0;
  for (const key of lowOrders > 0 && events.length > 2 ? ["uAmp", "uTime"] : []) {
    const n = events.length, v = events.map(e => e[key]);
    const rms0 = Math.sqrt(v.reduce((t, x) => t + x * x, 0) / n);
    let w = v.slice();
    // Remove the k-per-cycle components, k = 1 .. lowOrders, keeping at least two free orders.
    for (let k = 1; k <= lowOrders && 2 * k < n - 1; k++) {
      let re = 0, im = 0;
      w.forEach((x, i) => { re += x * Math.cos(2 * Math.PI * k * i / n); im += x * Math.sin(2 * Math.PI * k * i / n); });
      w = w.map((x, i) => x - (2 / n) * (re * Math.cos(2 * Math.PI * k * i / n) + im * Math.sin(2 * Math.PI * k * i / n)));
    }
    const rms1 = Math.sqrt(w.reduce((t, x) => t + x * x, 0) / n) || 1;
    w.forEach((x, i) => { events[i][key] = x * rms0 / rms1; });
  }

  const routing = info.banks < 2 ? "single" : s.routing;
  const fuelKind = info.rotary ? "rotary" : (info.twoStroke && !info.valves) ? "twoStroke" : s.fuel;
  const sc = s.aspiration === "supercharger" ? data.superchargers[s.scType || "roots"] : null;

  return {
    layoutId: s.layout,
    cycle: info.cycle,
    rotary: info.rotary,
    twoStroke: info.twoStroke,
    valves: info.valves,
    // Where in the cycle the intake event falls: just after TDC overlap in a four-stroke,
    // half a cycle after firing for ports and rotors.
    intakeFrac: info.rotary || info.twoStroke ? 0.5 : 380 / 720,
    propeller: propellerConfig(s),
    diesel: s.fuel === "diesel" && !info.rotary,
    banks: info.banks,
    events,
    eventsPerRev: info.eventsPerRev,
    cylinders: info.cylinders,
    cylVol,
    // Louder per pulse for bigger cylinders, quieter per pulse when there are many of them.
    cylScale: Math.pow(cylVol / 0.5, 0.35) / Math.sqrt(Math.max(1, info.cylinders) / 4),
    blowdownDeg: P.blowdownDeg[fuelKind],
    idleRpm: s.idleRpm,
    redline: s.redline,
    inertia: s.inertia,
    camLope: s.camLope,
    pops: s.pops,
    drivetrain: buildDrivetrain(data, s),
    torqueTable: torqueTable(s, data.drivetrain.driveFrictionScale),
    aspiration: s.aspiration,
    maxBoost: s.aspiration === "na" ? 0 : (s.boost ?? 1),
    turboSize: s.turboSize ?? 0.5,
    bov: s.bov || "atmospheric",
    sc: sc && {
      type: s.scType || "roots",
      ratio: s.scRatio ?? 2,
      pitch: sc.pitch, lobeFactor: sc.lobeFactor || 0, hzPerRpm: sc.hzPerRpm || 0,
      harmonics: sc.harmonics, level: sc.level,
    },
    exhaust: {
      routing,
      crossfeed: routing === "xpipe" ? 0.45 : routing === "single" ? 1 : 0,
      pipeDelaySec: [2 * s.pipeLength / c, 2 * s.pipeLength * 1.07 / c],
      chamberDelaySec: 2 * P.chamberLengthM / c,
      pipeFeedback: muffler.pipeFeedback,
      chamberFeedback: muffler.chamberFeedback,
      catLpHz: muffler.catLpHz,
      lpHz: muffler.lpHz, lpQ: muffler.lpQ,
      gain: muffler.gain,
      rasp: muffler.rasp,
    },
    intake: { ...intake },
    mix: { ...data.defaults.mix, ...s.mix },
    cycleVariance: P.cycleVariance,
    loadUnevenness: P.loadUnevenness,
    blockNoise: P.blockNoise,
    coldStart: s.coldStart ? { ...P.coldStart } : null,
    perspective: resolvePerspective(data, s.perspective),
  };
}

// The settings a preset implies, with every optional field filled.
// keep: listener choices that survive a preset change (perspective, coldStart).
export function settingsFromPreset(data, preset, mix, keep) {
  return {
    preset: preset.id,
    layout: preset.layout,
    displacement: preset.displacement,
    idleRpm: preset.idleRpm,
    redline: preset.redline,
    inertia: preset.inertia,
    fuel: preset.fuel,
    camLope: preset.camLope,
    pops: preset.pops,
    aspiration: preset.aspiration,
    boost: preset.boost ?? 1.0,
    turboSize: preset.turboSize ?? 0.5,
    bov: preset.bov ?? "atmospheric",
    scType: preset.scType ?? "roots",
    scRatio: preset.scRatio ?? 2.0,
    intake: preset.intake,
    headers: preset.headers,
    routing: preset.routing,
    muffler: preset.muffler,
    pipeLength: preset.pipeLength,
    mix: { ...data.defaults.mix, ...(mix || {}) },
    perspective: data.defaults.perspective,
    coldStart: false,
    vehicle: preset.vehicle ?? "car",
    firingOrder: preset.firingOrder,
    banks: preset.banks,
    propeller: preset.propeller,
    torque: preset.torque,
    transmission: preset.transmission ?? "manual",
    gearCut: preset.gearCut ?? "helical",
    shiftMode: "auto",
    revMatch: true,
    ...(keep || {}),
  };
}
