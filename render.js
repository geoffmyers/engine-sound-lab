// Offline rendering of a scripted run (engine-data.json "scenarios") straight through the
// DSP, plus a 16-bit WAV encoder. Used by the page's export and by the Node tests.
import { EngineDSP } from "./engine-dsp.js";
import { buildConfig } from "./engine-config.js";

export function renderScenario(data, settings, scenarioId, sampleRate = 48000, { block = 128, seed = 7 } = {}) {
  const sc = data.scenarios[scenarioId];
  if (!sc) throw new Error(`Unknown scenario ${scenarioId}`);
  const dsp = new EngineDSP(sampleRate, seed);
  dsp.setConfig(buildConfig(data, settings));
  if (sc.mode) dsp.setMode(sc.mode);
  dsp.setScript(sc.events);
  const total = Math.round(sc.seconds * sampleRate);
  const L = new Float32Array(total), R = new Float32Array(total);
  const bl = new Float32Array(block), br = new Float32Array(block);
  const trace = [];
  for (let pos = 0; pos < total; pos += block) {
    const n = Math.min(block, total - pos);
    dsp.process(bl, br, n);
    L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos);
    const s = dsp.snapshot();
    if (s) trace.push(s);
  }
  return { L, R, sampleRate, trace };
}

export function encodeWav(L, R, sampleRate) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  return buf;
}
