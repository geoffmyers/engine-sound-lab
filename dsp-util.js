// Small DSP building blocks shared by the engine and the drivetrain. Plain JS: runs in an
// AudioWorklet and under Node.
export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  // Uniform in [-1, 1).
  uni() {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 2147483648 - 1;
  }
  unit() { return (this.uni() + 1) * 0.5; }
  gauss() { return (this.uni() + this.uni() + this.uni()) * 0.577; }
}

export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    f = clamp(f, 10, sr * 0.45);
    const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === "bp") { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else { // peaking
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export class OnePole {
  constructor() { this.a = 1; this.y = 0; }
  set(f, sr) { this.a = 1 - Math.exp(-TAU * clamp(f, 5, sr * 0.49) / sr); return this; }
  run(x) { this.y += this.a * (x - this.y); return this.y; }
}

export class DelayLine {
  constructor(size) {
    let n = 1; while (n < size + 4) n <<= 1;
    this.buf = new Float32Array(n); this.mask = n - 1; this.w = 0;
  }
  // The value written d samples ago (d >= 1), linearly interpolated.
  read(d) {
    const idx = this.w - d, i0 = Math.floor(idx), f = idx - i0;
    return this.buf[i0 & this.mask] * (1 - f) + this.buf[(i0 + 1) & this.mask] * f;
  }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
}

// Boost an engine settles at under full throttle at a given fraction x of its rev limit,
// in bar. It must agree with EngineDSP.updateBoost (tests/dsp-check.mjs compares them): the
// torque table divides this out so the real curve is reached only once boost has built.
export function steadyBoostWOT(aspiration, maxBoost, turboSize, scType, x) {
  if (aspiration === "turbo") {
    const s = turboSize, spool0 = 0.16 + 0.38 * s, spool1 = spool0 + 0.2 + 0.1 * s;
    const flow = smoothstep(spool0, spool1, x);
    const w = clamp(0.06 + 0.25 * x + 0.8 * flow, 0, 1);
    return maxBoost * Math.pow(clamp((w - 0.3) / 0.6, 0, 1), 1.2);
  }
  if (aspiration === "supercharger") return scType === "centrifugal" ? maxBoost * x * x : maxBoost * (0.75 + 0.25 * x);
  return 0;
}

// Engine friction (as a fraction of the torque unit) at fraction x of the rev limit and
// effective throttle te. Shared by the DSP and the torque table.
export const frictionAt = (x, te) => 0.12 + 0.18 * x + 0.30 * x * x + 0.10 * (1 - te);
// Manifold load, naturally aspirated, at effective throttle te.
export const loadNAAt = (x, te) => 0.12 + 0.88 * clamp(te * (1.7 - 0.7 * x), 0, 1);
