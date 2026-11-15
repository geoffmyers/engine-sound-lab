// Render a preset to a WAV for side-by-side analysis with a real recording.
// Usage: node scripts/render-preset.mjs PRESET OUT.wav [--seconds 20] [--idle RPM]
//          [--hold RPM --throttle 0..1] [--set key=value ...]
//   --idle RPM    idle with the idle speed set to RPM (free mode, no throttle)
//   --hold RPM    dyno-hold at RPM with the given throttle instead
//   --set k=v     override any setting, e.g. --set routing=dual --set mix.intake=0
//   --patch F     deep-merge JSON file F into engine-data.json first (used by fit-perspectives.py)
import { readFileSync, writeFileSync } from "node:fs";
import { renderScenario, encodeWav } from "../render.js";
import { settingsFromPreset } from "../engine-config.js";

const data = JSON.parse(readFileSync(new URL("../engine-data.json", import.meta.url), "utf8"));
const [presetId, out, ...rest] = process.argv.slice(2);
const opt = { seconds: 20, set: [] };
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, ""), v = rest[i + 1];
  if (k === "set") opt.set.push(v); else if (k === "patch") opt.patch = v; else opt[k] = Number(v);
}
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === "object" && !Array.isArray(v) && a[k]) merge(a[k], v); else a[k] = v; } };
if (opt.patch) merge(data, JSON.parse(readFileSync(opt.patch, "utf8")));
const preset = data.presets.find(p => p.id === presetId);
if (!preset || !out) { console.error("usage: render-preset.mjs PRESET OUT.wav [options]"); process.exit(2); }
const s = settingsFromPreset(data, preset);
if (opt.idle) s.idleRpm = opt.idle;
for (const kv of opt.set) {
  const [k, v] = kv.split("=");
  const val = isNaN(Number(v)) ? v : Number(v);
  if (k.startsWith("mix.")) s.mix[k.slice(4)] = val; else s[k] = val;
}
const events = [[0, "start"]];
let mode;
if (opt.hold) { mode = "dyno"; events.push([0.01, "hold", opt.hold / s.redline], [1.0, "throttle", opt.throttle ?? 0.1]); }
data.scenarios._cli = { seconds: opt.seconds, mode, events };
const r = renderScenario(data, s, "_cli", 44100);
writeFileSync(out, Buffer.from(encodeWav(r.L, r.R, 44100)));
console.log(`wrote ${out}: ${preset.label}, ${opt.seconds} s`);
