// Renders every preset through the DSP under Node and checks the output is sane:
// finite samples, no hard clipping, plausible loudness at idle and full throttle, the
// firing order showing up in the spectrum, and the drivetrain reaching the limiter.
// Usage: node tests/dsp-check.mjs [wavOutDir]   (writes WAVs only when a dir is given)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderScenario, encodeWav } from "../render.js";
import { settingsFromPreset, layoutInfo, firingHz } from "../engine-config.js";

const here = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("engine-data.json", here), "utf8"));
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const SR = 48000;
let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };

const rms = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const db = (v) => (20 * Math.log10(v + 1e-12)).toFixed(1);
function goertzel(a, from, to, f) {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - from) / (to - from)); // Hann
    const s = a[i] * h + c * s1 - s2; s2 = s1; s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (to - from);
}

// A steady dyno hold at 3000 rpm, half throttle, for the spectrum check.
data.scenarios["hold-3000"] = { seconds: 5, mode: "dyno", events: [[0, "start"], [1.5, "throttle", 0.5]] };

console.log("preset".padEnd(16), "idle dB", "WOT dB", "peak", "maxRpm", "strongest order @3000 (expected firing order)");
for (const p of data.presets) {
  const s = settingsFromPreset(data, p);
  const info = layoutInfo(data, s.layout, s);

  const idle = renderScenario(data, s, "idle", SR);
  const pull = renderScenario(data, s, "pull", SR);
  const blips = renderScenario(data, s, "start-and-blips", SR);
  for (const [name, r] of [["idle", idle], ["pull", pull], ["blips", blips]]) {
    for (const ch of [r.L, r.R]) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) { fail(`${p.id} ${name}: non-finite sample at ${i}`); break; }
  }
  const idleRms = rms(idle.L, 3 * SR, 6 * SR);
  const wotRms = rms(pull.L, 3 * SR, 12 * SR);
  let peak = 0; for (const a of [pull.L, pull.R, blips.L, blips.R]) for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  const maxRpm = Math.max(...pull.trace.map(t => t.rpm));
  const idleTrace = idle.trace.filter(t => t.time > 3);
  const idleMean = idleTrace.reduce((a, t) => a + t.rpm, 0) / idleTrace.length;

  // Spectrum at a held speed: magnitude of each half-order (cam order) harmonic.
  // A Wankel's eccentric shaft has no cam, so its orders are counted per shaft revolution.
  // Below each engine's limit, and never below its idle (the dyno will not hold lower; a
  // governed mower "idles" at 2,900).
  const rpm = Math.max(p.idleRpm, Math.min(p.redline > 12000 ? 9000 : 3000, Math.round(0.6 * p.redline)));
  data.scenarios["hold-3000"].events = [[0, "start"], [0.01, "hold", rpm / p.redline], [1.5, "throttle", 0.5]];
  const hold = renderScenario(data, s, "hold-3000", SR);
  // Measure the mono sum: with true-dual pipes each speaker carries mostly one bank, and a
  // flat-plane V8's banks (two inline-4s) only cancel each other's order 4 in the sum.
  const mono = hold.L.map((v, i) => 0.5 * (v + hold.R[i]));
  const base = rpm / 60 * 360 / info.cycle; // Hz of one cycle
  let best = 0, bestK = 0; const mags = [];
  for (let k = 1; k <= 2 * info.cylinders + 2; k++) {
    const m = goertzel(mono, 2 * SR, 5 * SR, base * k); mags.push(m);
    if (m > best) { best = m; bestK = k; }
  }
  const expectK = info.cylinders; // events per cycle
  const fire = firingHz(info, rpm);

  console.log(p.id.padEnd(16), db(idleRms).padStart(7), db(wotRms).padStart(6), peak.toFixed(2).padStart(5),
    String(Math.round(maxRpm)).padStart(6), `${bestK} (${expectK}; firing ${fire.toFixed(0)} Hz)`,
    `idle ${Math.round(idleMean)}/${p.idleRpm}`);

  // Guards against a silent or broken engine, not loudness balance (the master level is set
  // so the default rear perspective has headroom; quiet presets sit around -31 dB).
  if (wotRms < 0.016) fail(`${p.id}: full throttle too quiet (${db(wotRms)} dB)`);
  if (idleRms > wotRms) fail(`${p.id}: idle louder than full throttle`);
  // A fixed-pitch propeller loads the engine so full throttle settles near 90-95% of rated rpm.
  if (maxRpm < p.redline * (p.propeller ? 0.85 : 0.97)) fail(`${p.id}: pull never reached the limiter (${Math.round(maxRpm)} of ${p.redline})`);
  if (Math.abs(idleMean - p.idleRpm) > p.idleRpm * 0.12) fail(`${p.id}: idle settles at ${Math.round(idleMean)} rpm, not ${p.idleRpm}`);
  // An even-firing engine's firing frequency must be a strong component: within 12 dB of the
  // strongest order. Uneven firing (cross-plane, odd-fire, twins) spreads energy across orders.
  // Only for one collector: with split pipes each bank's own pattern legitimately dominates
  // (a cross-plane V8's burble, a flat-plane V8's two inline-4s).
  const evenFire = info.intervals.every(v => v === info.intervals[0]) && (info.banks < 2 || s.routing === "single");
  if (evenFire && mags[expectK - 1] < best / 4) fail(`${p.id}: firing order ${expectK} is ${db(mags[expectK - 1] / best)} dB below order ${bestK}`);

  if (outDir) {
    for (const [name, r] of [["idle", idle], ["pull", pull], ["blips", blips]]) {
      writeFileSync(`${outDir}/${p.id}-${name}.wav`, Buffer.from(encodeWav(r.L, r.R, SR)));
    }
  }
}
// ---- drivetrain -------------------------------------------------------------------
console.log("\ndrivetrain (BMW S65 preset):");
const s65 = () => settingsFromPreset(data, data.presets.find(p => p.id === "bmw-s65"));
const only = (s) => { Object.assign(s.mix, { exhaust: 0, intake: 0, mechanical: 0, induction: 0, road: 0, gearbox: 1 }); s.perspective = "dry"; return s; };
{
  const r = renderScenario(data, s65(), "pull-and-brake", SR);
  const maxGear = Math.max(...r.trace.map(t => t.gear)), maxKmh = Math.max(...r.trace.map(t => t.speedKmh));
  const end = r.trace[r.trace.length - 1];
  // A shift passes through neutral (3 -> N -> 2), so compare against the last gear engaged.
  let downs = 0, lastGear = 0;
  for (const t of r.trace) { if (t.gear > 0) { if (lastGear > 0 && t.gear < lastGear) downs++; lastGear = t.gear; } }
  const stalled = r.trace.some(t => t.time > 2 && t.state !== "running");
  console.log(`  pull and brake: top gear ${maxGear}, ${maxKmh.toFixed(0)} km/h, ends at ${end.speedKmh.toFixed(1)} km/h in gear ${end.gear}, ${downs} downshifts, stalled ${stalled}`);
  if (maxGear < 4 || maxKmh < 120) fail("pull did not reach 4th gear and 120 km/h");
  if (end.speedKmh > 15) fail("brakes did not stop the car");
  if (downs < 2) fail("no automatic downshifts while braking");
  if (stalled) fail("engine stalled in the drive scenario");

  // Racing downshifts: once the next gear down fits under the redline, take it. Measure how
  // long the box stays in a gear after that point while braking, and where each shift lands.
  const car = data.drivetrain.vehicles.car, redline = data.presets.find(p => p.id === "bmw-s65").redline;
  const rpmIn = (g, kmh) => kmh / 3.6 / car.vehicle.wheelRadiusM * car.gearboxRatios[g - 1] * car.finalDrive * 60 / (2 * Math.PI);
  let late = 0, worst = 0, lastG = 0; const landings = [];
  for (const t of r.trace) {
    if (t.brake > 0 && t.gear > 1 && !t.shifting && rpmIn(t.gear - 1, t.speedKmh) < 0.95 * redline) { late++; worst = Math.max(worst, late); } else late = 0;
    if (t.gear > 0) { if (lastG > 0 && t.gear < lastG) landings.push(Math.round(rpmIn(t.gear, t.speedKmh))); lastG = t.gear; }
  }
  console.log(`  downshifts landed at ${landings.join(", ")} rpm (redline ${redline}); longest wait once the lower gear fit: ${(worst * 0.025).toFixed(3)} s`);
  if (worst * 0.025 > 0.15) fail("an automatic downshift waited after the lower gear fitted under the redline");
}
{
  const level = (gc) => { const s = only(s65()); s.gearCut = gc; const r = renderScenario(data, s, "pull", SR); return rms(r.L, 3 * SR, 12 * SR); };
  const st = level("straight"), he = level("helical");
  console.log(`  gearbox-only level in a pull: straight-cut ${db(st)} dB, helical ${db(he)} dB`);
  // The whine itself differs by ~18 dB; clunks, shifter clicks and synchros are shared.
  if (20 * Math.log10(st / he) < 10) fail("straight-cut gears are not at least 10 dB louder than helical");
}
{
  // Whine at the predicted mesh frequency: steady 3rd gear on a dyno-free part throttle.
  const s = only(s65()); s.gearCut = "straight"; s.shiftMode = "manual";
  data.scenarios._mesh = { seconds: 9, mode: "drive", events: [[0, "start"], [1.5, "upshift"], [2.0, "throttle", 0.6], [3.5, "upshift"], [4.6, "upshift"], [5.6, "throttle", 0.25]] };
  const r = renderScenario(data, s, "_mesh", SR);
  const seg = r.trace.filter(t => t.time > 7 && t.time < 8.5);
  const gear = seg[0].gear, rpm = seg.reduce((a, t) => a + t.rpm, 0) / seg.length;
  const ratio = data.drivetrain.vehicles.car.gearboxRatios[gear - 1], gb = data.drivetrain.vehicles.car.gearbox;
  const f = rpm / 60 * gb.pairTeethSum / (gb.headRatio + ratio);
  const on = goertzel(r.L, 7.6 * SR, 8.0 * SR, f), off = Math.max(goertzel(r.L, 7.6 * SR, 8.0 * SR, f * 1.17), goertzel(r.L, 7.6 * SR, 8.0 * SR, f * 0.85));
  console.log(`  gear ${gear} at ${rpm.toFixed(0)} rpm: mesh line at ${f.toFixed(0)} Hz stands ${db(on / off)} dB above its neighbourhood`);
  if (gear !== 3) fail(`manual upshifts landed in gear ${gear}, not 3rd`);
  if (on < off * 3) fail("no gear whine at the predicted mesh frequency");
}
{
  const s = s65();
  data.scenarios._refuse = { seconds: 12, mode: "drive", events: [[0, "start"], [2.0, "throttle", 1], [10.0, "downshift"], [10.02, "downshift"]] };
  const r = renderScenario(data, s, "_refuse", SR);
  const refused = r.trace.find(t => t.refused);
  console.log(`  over-revving downshift: ${refused ? `refused ("${refused.refused}")` : "NOT refused"}`);
  if (!refused) fail("an over-revving downshift was not refused");
}
for (const tx of ["sequential", "dct"]) {
  const s = s65(); s.transmission = tx;
  const r = renderScenario(data, s, "pull-and-brake", SR);
  let bad = false; for (const a of [r.L, r.R]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { bad = true; break; }
  const maxGear = Math.max(...r.trace.map(t => t.gear)), end = r.trace[r.trace.length - 1];
  console.log(`  ${tx}: top gear ${maxGear}, ends at ${end.speedKmh.toFixed(1)} km/h, finite ${!bad}`);
  if (bad || maxGear < 4 || end.speedKmh > 15) fail(`${tx} transmission failed the pull-and-brake run`);
}
{
  const s = s65(); s.shiftMode = "manual";
  const r = renderScenario(data, s, "pull", SR);
  const moved = Math.max(...r.trace.map(t => t.speedKmh)), maxGear = Math.max(...r.trace.map(t => t.gear));
  console.log(`  manual shifting with no shifts: gear ${maxGear}, ${moved.toFixed(1)} km/h`);
  if (maxGear !== 0 || moved > 0.5) fail("manual shift mode left neutral without being asked");
}

{
  // The pops have their own mixer channel: at 0 they are gone, doubling it doubles them, and it
  // never changes anything else (the random sequence is drawn the same way at every level).
  const blips = (m) => { const s = s65(); s.pops = 0.6; s.mix.pops = m; return renderScenario(data, s, "start-and-blips", SR).L; };
  const a0 = blips(0), a1 = blips(data.defaults.mix.pops), a2 = blips(2 * data.defaults.mix.pops);
  let pk0 = 0, pkP = 0, nonlin = 0;
  for (let i = 0; i < a0.length; i++) {
    const p1 = a1[i] - a0[i], p2 = a2[i] - a0[i];
    pk0 = Math.max(pk0, Math.abs(a0[i])); pkP = Math.max(pkP, Math.abs(p1)); nonlin = Math.max(nonlin, Math.abs(p2 - 2 * p1));
  }
  const W = 2400, loud = (f) => { let m = 0; for (let i = 0; i + W < a0.length; i += 600) { let e = 0; for (let j = i; j < i + W; j++) { const v = f(j); e += v * v; } m = Math.max(m, Math.sqrt(e / W)); } return m; };
  const lE = loud(i => a0[i]), lP = loud(i => a1[i] - a0[i]);
  console.log(`  pops channel, loudest 50 ms: engine ${db(lE)} dBFS, pops ${db(lP)} dBFS`);
  if (lP > lE) fail("pops at the default mixer level are louder than the engine at its loudest");
  console.log(`  pops channel: engine peak ${db(pk0)} dBFS, pops at the default ${db(pkP)} dBFS, doubling error ${db(nonlin)} dB re full scale`);
  if (pkP < 1e-4) fail("the pops channel at its default made no pops");
  if (pkP > 2.5 * pk0) fail("pops at the default mixer level are more than 8 dB above the engine's peak");
  if (nonlin > 0.25 * pkP) fail("the pops channel does not scale the pops linearly");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
