// Block-rate artefact check. process() updates levels and filter coefficients once per block
// (128 samples in the worklet), so a parameter that steps every block would add a component that
// repeats every 128 samples, heard as lines at multiples of sampleRate / 128: EngineLab found
// exactly such lines and heard them as "metallic". Following its method, each case is rendered
// with 128-sample blocks and folded at 128 samples (the mean waveform over all blocks): whatever
// repeats every block survives, anything else averages down to 1/N of its power. The same case
// rendered with 96-sample blocks and folded at 128 is the control (the engine's own orders can
// repeat at 375 Hz too, in both). Renders are a minute long, so chance leaves -43 dB; a case
// fails when its block-periodic part stands MARGIN dB above chance and above the control.
// Checked 2026-11-16: no case did. Sensitivity, from a sawtooth added at the block rate to the
// S65's fast sweeps: at -30 dB re the total it stands 11 dB above chance (caught), at -40 dB
// 2 dB (not); EngineLab's audible lines were about -32 dB.
// Usage: node scripts/block-rate-check.mjs [PRESET ...]
import { readFileSync } from "node:fs";
import { renderScenario } from "../render.js";
import { settingsFromPreset } from "../engine-config.js";

const data = JSON.parse(readFileSync(new URL("../engine-data.json", import.meta.url), "utf8"));
const SR = 48000, SECONDS = 61.5, MARGIN = 6;
const presets = process.argv.slice(2).length ? process.argv.slice(2)
  : ["bmw-s65", "i6-big-turbo", "twinscrew-v8", "diesel-i4"];
// Fast full-throttle sweeps between 30% and 90% of the limit, 5 s each way: the levels set once
// per block change fastest here.
const sweeps = [[0, "start"], [0.01, "hold", 0.3], [1.0, "throttle", 1]];
for (let t = 1.5, up = true; t < SECONDS - 1.5; t += 5, up = !up) sweeps.push([t, "sweep", up ? 0.3 : 0.9, up ? 0.9 : 0.3, 5]);
const CASES = {
  "steady WOT": [[0, "start"], [0.01, "hold", 0.6], [1.0, "throttle", 1]],
  "fast sweeps": sweeps,
};

// Power of the component that repeats every P samples, relative to the total (both in dB), and
// how far it stands above what N random blocks would leave (0 dB for no periodic part).
function fold(x, from, P) {
  const N = Math.floor((x.length - from) / P), avg = new Float64Array(P);
  let mean = 0, tot = 0;
  for (let i = from; i < from + N * P; i++) mean += x[i];
  mean /= N * P;
  for (let b = 0; b < N; b++) for (let j = 0; j < P; j++) { const v = x[from + b * P + j] - mean; avg[j] += v; tot += v * v; }
  let pf = 0;
  for (let j = 0; j < P; j++) { avg[j] /= N; pf += avg[j] * avg[j]; }
  pf /= P; tot /= N * P;
  return { rel: 10 * Math.log10(pf / tot), excess: 10 * Math.log10(pf * N / tot) };
}

function render(preset, events, block) {
  const s = settingsFromPreset(data, preset);
  data.scenarios._blk = { seconds: SECONDS, mode: "dyno", events };
  const r = renderScenario(data, s, "_blk", SR, { block, seed: 7 });
  const m = new Float64Array(r.L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (r.L[i] + r.R[i]);
  return m;
}

let failed = 0;
console.log(`component repeating every 128 samples (${(SR / 128).toFixed(1)} Hz and its multiples), dB re the total; control = 96-sample blocks`);
for (const id of presets) {
  const preset = data.presets.find(p => p.id === id);
  if (!preset) { console.error(`no preset ${id}`); process.exit(2); }
  for (const [name, events] of Object.entries(CASES)) {
    const from = 128 * 96 * 6;   // 1.536 s at 48 kHz, on a block boundary of both sizes
    const a = fold(render(preset, events, 128), from, 128), b = fold(render(preset, events, 96), from, 128);
    const bad = a.excess > MARGIN && a.excess - b.excess > MARGIN;
    if (bad) failed++;
    console.log(`${id.padEnd(14)} ${name.padEnd(11)} ${a.rel.toFixed(1).padStart(6)} dB (${a.excess.toFixed(1).padStart(5)} dB above chance; control ${b.excess.toFixed(1).padStart(5)})${bad ? "  <-- block-rate artefact" : ""}`);
  }
}
console.log(failed ? `${failed} case(s) with a block-rate component` : "no block-rate component");
process.exit(failed ? 1 : 0);
