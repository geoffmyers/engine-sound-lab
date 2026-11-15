// AudioWorklet wrapper around the DSP core: the page sends config and control messages,
// the processor renders audio and posts engine state back about 40 times a second.
import { EngineDSP } from "./engine-dsp.js";

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.dsp = new EngineDSP(sampleRate, o.seed || 1);
    if (o.config) this.dsp.setConfig(o.config);
    this.port.onmessage = (e) => this.dsp.handle(e.data);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    this.dsp.process(L, R, L.length);
    const s = this.dsp.snapshot();
    if (s) this.port.postMessage(s);
    return true;
  }
}

registerProcessor("engine-processor", EngineProcessor);
