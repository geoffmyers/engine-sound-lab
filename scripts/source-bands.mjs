// Which source carries each octave band: render a preset at a steady hold from one listening
// position with each mixer channel soloed, and print every source's octave-band levels (dB re
// the full mix's total), so a spectral excess can be traced to the stage that makes it.
// Usage: node scripts/source-bands.mjs PRESET RPM PERSPECTIVE [--throttle 1] [--seconds 4] [--patch F.json]
//   --patch F  deep-merge JSON file F into engine-data.json first (try a change without editing it)
//   RPM 0 idles. Mechanical includes the block noise and valve clicks.
import { readFileSync } from "node:fs";
import { renderScenario } from "../render.js";
import { settingsFromPreset } from "../engine-config.js";

const data = JSON.parse(readFileSync(new URL("../engine-data.json", import.meta.url), "utf8"));
const [presetId, rpmArg, persp, ...rest] = process.argv.slice(2);
const opt = { throttle: 1, seconds: 4 };
for (let i = 0; i < rest.length; i += 2) { const k = rest[i].replace(/^--/, ""); opt[k] = k === "patch" ? rest[i + 1] : Number(rest[i + 1]); }
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === "object" && !Array.isArray(v) && a[k]) merge(a[k], v); else a[k] = v; } };
if (opt.patch) merge(data, JSON.parse(readFileSync(opt.patch, "utf8")));
const preset = data.presets.find(p => p.id === presetId);
if (!preset || !persp) { console.error("usage: source-bands.mjs PRESET RPM PERSPECTIVE [--throttle T] [--seconds S]"); process.exit(2); }
const SR = 44100, rpm = Number(rpmArg);
const CHANNELS = ["exhaust", "intake", "mechanical", "induction", "gearbox", "road", "pops"];
const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

function render(solo) {
  const s = settingsFromPreset(data, preset);
  s.perspective = persp;
  if (solo) for (const ch of CHANNELS) if (ch !== solo && ch !== "pops") s.mix[ch] = 0;
  const events = [[0, "start"]];
  if (rpm > 0) events.push([0.01, "hold", rpm / s.redline], [1.0, "throttle", opt.throttle]);
  data.scenarios._src = { seconds: opt.seconds, mode: rpm > 0 ? "dyno" : "free", events };
  const r = renderScenario(data, s, "_src", SR);
  const from = Math.round(1.5 * SR), n = 1 << Math.floor(Math.log2(r.L.length - from));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * (r.L[from + i] + r.R[from + i]);
  return bandEnergy(x);
}

// Octave-band energies from one Hann-windowed FFT.
function bandEnergy(x) {
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const e = BANDS.map(() => 0);
  for (let k = 1; k < n / 2; k++) {
    const f = k * SR / n, p = re[k] * re[k] + im[k] * im[k];
    BANDS.forEach((c, b) => { if (f >= c / Math.SQRT2 && f < c * Math.SQRT2) e[b] += p; });
  }
  return e;
}

const all = render(null), total = all.reduce((a, b) => a + b, 0);
const db = v => (10 * Math.log10(v / total + 1e-15)).toFixed(1).padStart(6);
console.log(`${preset.label}, ${rpm || "idle"} rpm, throttle ${opt.throttle}, ${persp}: octave bands in dB re the full mix's total`);
console.log("source     " + BANDS.map(b => String(b).padStart(6)).join(""));
console.log("all        " + all.map(db).join(""));
for (const ch of CHANNELS.slice(0, 6)) console.log(ch.padEnd(11) + render(ch).map(db).join(""));
