// Measure each real preset against its published figures: full-throttle peak torque and
// power from the calibrated table, boost the DSP actually reaches, and 0-60 mph in Drive
// against research/2026-11-15-acceleration.json.
// Usage: node scripts/check-acceleration.mjs [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { renderScenario } from "../render.js";
import { settingsFromPreset, buildConfig, wotTorqueCurve } from "../engine-config.js";
import { steadyBoostWOT, frictionAt, loadNAAt } from "../dsp-util.js";

const data = JSON.parse(readFileSync(new URL("../engine-data.json", import.meta.url), "utf8"));
const accel = JSON.parse(readFileSync(new URL("../research/2026-11-15-acceleration.json", import.meta.url), "utf8"));
// Research names -> preset ids (the research list was written in this order).
const ACCEL_IDS = ["porsche-911-gt3-992", "ferrari-458-italia", "lexus-lfa", "ford-mustang-gt-s550", "chevrolet-corvette-c8",
  "dodge-challenger-hellcat", "honda-s2000-ap1", "honda-civic-type-r-fl5", "mazda-rx7-fd", "toyota-supra-a80", "nissan-gt-r-r35",
  "subaru-wrx-sti-grb", "audi-rs3-8y", "bmw-m3-e46", "mercedes-sls-amg", "lamborghini-aventador", "toyota-gr86", "mazda-mx5-nd2",
  "vw-beetle-1600", "bmw-s65", "ducati-panigale-v4", "suzuki-hayabusa", "harley-street-bob-114"];
const target = {};
accel.forEach((a, i) => { const t = a.zeroTo60MphS ?? (a.zeroTo100KmhS != null ? a.zeroTo100KmhS * 0.96 : null); if (t) target[ACCEL_IDS[i]] = t; });

export function calibration(p) {
  const s = settingsFromPreset(data, p), c = buildConfig(data, s), tt = c.torqueTable, fs = data.drivetrain.driveFrictionScale;
  let pkT = 0, pkTr = 0, pkP = 0, pkPr = 0;
  for (let i = 1; i <= 200; i++) {
    const x = i / 200, rpm = x * p.redline;
    const n = tt.base.length, fi = x / tt.xMax * (n - 1), i0 = Math.floor(fi), f = fi - i0;
    const base = tt.base[i0] * (1 - f) + tt.base[i0 + 1] * f;
    const b = steadyBoostWOT(s.aspiration, c.maxBoost, s.turboSize ?? 0.5, s.scType, x);
    const T = (base * (1 + b) * loadNAAt(x, 1) - frictionAt(x, 1) * fs) * tt.Tunit;
    const P = T * rpm * 2 * Math.PI / 60 / 1000;
    if (T > pkT) { pkT = T; pkTr = rpm; }
    if (P > pkP) { pkP = P; pkPr = rpm; }
  }
  return { pkT, pkTr, pkP, pkPr };
}

// As magazines run it: launch control (brake and full throttle, then release the brake),
// and the US convention of starting the clock after the first foot of roll-out.
export function zeroTo60(p) {
  const s = settingsFromPreset(data, p);
  data.scenarios._a = { seconds: 16, mode: "drive", events: [[0, "start"], [2.0, "brake", 1], [2.0, "throttle", 1], [3.5, "brake", 0]] };
  const r = renderScenario(data, s, "_a", 16000);
  let dist = 0, t0 = null, prev = null;
  for (const t of r.trace) {
    if (prev && t.time > 3.5) dist += (t.speedKmh + prev.speedKmh) / 2 / 3.6 * (t.time - prev.time);
    if (t0 === null && dist >= 0.3048) t0 = t.time;
    if (t0 !== null && t.speedKmh >= 96.56) return t.time - t0;
    prev = t;
  }
  return null;
}

export function boostAgreement(p) {
  const s = settingsFromPreset(data, p);
  if (s.aspiration === "na") return null;
  const c = buildConfig(data, s), x = 0.7;
  data.scenarios._b = { seconds: 6, mode: "dyno", events: [[0, "start"], [0.01, "hold", x], [1.0, "throttle", 1]] };
  const r = renderScenario(data, s, "_b", 16000);
  const got = r.trace.at(-1).boost, want = steadyBoostWOT(s.aspiration, c.maxBoost, s.turboSize ?? 0.5, s.scType, x);
  return { got, want };
}

// Tolerances: the torque table must reproduce the published peaks; the DSP's boost must
// match the shared formula the table divides out. 0-60 mph is checked one way only: the
// tyres have full traction (no wheelspin is simulated), so a car is expected to beat its
// magazine time, which grip limits; one SLOWER than 125% of it points at the torque, the
// gearing or the shifts.
const TOL = { torque: 0.03, power: 0.04, boost: 0.03, zeroTo60: 0.25 };

if (import.meta.url === `file://${process.argv[1]}`) {
  let failures = 0;
  const fail = (m) => { failures++; console.log("  FAIL " + m); };
  const rows = [];
  console.log("preset".padEnd(26), "torque model/spec", "  power model/spec", "  0-60 mph sim/real");
  for (const p of data.presets.filter(p => p.real && p.torque)) {
    const cal = calibration(p);
    const t60 = p.vehicle !== "none" && target[p.id] ? zeroTo60(p) : null;
    const bo = boostAgreement(p);
    rows.push({ id: p.id, ...cal, spec: p.torque, t60, real60: target[p.id] ?? null, boost: bo });
    console.log(p.id.padEnd(26), `${cal.pkT.toFixed(0).padStart(6)}/${String(p.torque.peakNm).padEnd(6)}`, `${cal.pkP.toFixed(0).padStart(6)}/${String(p.torque.powerKw).padEnd(6)}`,
      t60 != null ? `${t60.toFixed(1).padStart(6)}/${target[p.id]} s` : "", bo ? `boost ${bo.got.toFixed(2)}/${bo.want.toFixed(2)}` : "");
    const T = p.torque, w = (rpm) => rpm * 2 * Math.PI / 60;
    if (Math.abs(cal.pkT / T.peakNm - 1) > TOL.torque) fail(`${p.id}: peak torque ${cal.pkT.toFixed(0)} vs ${T.peakNm} N·m`);
    // A spec whose peak torque at its rpm already exceeds the rated power contradicts itself.
    const inconsistent = T.peakNm * w(T.peakRpm) / 1000 > T.powerKw * 1.02;
    if (inconsistent) console.log(`  note ${p.id}: published torque implies ${(T.peakNm * w(T.peakRpm) / 1000).toFixed(1)} kW at ${T.peakRpm} rpm, above the rated ${T.powerKw} kW; power not checked`);
    else if (Math.abs(cal.pkP / T.powerKw - 1) > TOL.power) fail(`${p.id}: peak power ${cal.pkP.toFixed(0)} vs ${T.powerKw} kW`);
    if (bo && Math.abs(bo.got - bo.want) > TOL.boost * Math.max(1, bo.want)) fail(`${p.id}: DSP boost ${bo.got.toFixed(2)} vs formula ${bo.want.toFixed(2)} bar`);
    if (t60 != null && t60 / target[p.id] - 1 > TOL.zeroTo60) fail(`${p.id}: 0-60 mph ${t60.toFixed(1)} s, slower than the real ${target[p.id]} s by more than ${TOL.zeroTo60 * 100}%`);
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nall calibration checks passed");
  process.exitCode = failures ? 1 : 0;
  const i = process.argv.indexOf("--json"); if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(rows, null, 1));
}
