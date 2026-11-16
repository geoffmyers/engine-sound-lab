# BMW S65 recordings against Engine Sound Lab

## The recordings

Three Zoom H4n takes of the author's car from 2026-07-22 (44.1 kHz, 16-bit stereo; the
recordings themselves are not in this repository):

| Take | Mic position | Length | What happens |
|------|-------------|--------|--------------|
| STE-035 | Behind the tailpipes | 122 s | True cold start, idle, shutdown at 115 s |
| STE-036 | Front, at the intake | 84 s | Restart about 2 minutes later, warmer |
| STE-037 | Open engine bay | 94 s | Restart about 2 minutes after that |

All three are idle only: no revving. So they calibrate idle and the listening path, not
full throttle.

Both tools are committed beside the app: `scripts/analyze-recording.py` measures a
recording and a synth render identically, and `scripts/fit-perspectives.py` fits the
listening positions. Synth renders come from `scripts/render-preset.mjs`.

## What the recordings show

- **Warm idle is 786 rpm** in all three takes (firing line 52.4 Hz). The preset said 650.
- **Cold start, STE-035:** idle eases from 1,216 rpm to 786 over about 60 s, while the
  exhaust stays about 9 dB louder at the same rpm until about 79 s after start, then
  falls 10 dB within about 6 s. That is catalyst heating ending (retarded ignition makes
  hotter, louder pulses), not an idle step.
- **The idle is harmonically clean from behind:** the firing order dominates, its double
  is at -16 dB, and the cross-plane "burble" half-orders are 30 to 52 dB down. A single
  merged collector matches this better than an X-pipe or true dual.
- **Cycle-to-cycle variation is large (CV 0.14 warm, 0.21 cold) yet the half-orders stay
  clean.** So the variation drifts over several cycles; independent per-firing jitter
  would fill in the half-orders.
- **Above 250 Hz the rear warm-idle take is ambient noise** (3-10 dB above the silence
  before the start). Any fit there fits the garage, not the car. The engine-bay take has
  18-30 dB SNR everywhere.
- **The engine-bay take has strong handling or vibration noise below 30 Hz** (42% of its
  energy, left and right channels anti-correlated); everything is high-passed at 30 Hz.
- **Relative levels** (same recorder, assuming the gain was not touched): at warm idle the
  intake position is 16 dB and the engine bay 11 dB quieter than behind the car.
- Shutdown cannot measure the room: the engine keeps spinning down and firing weakly for
  about half a second, which hides any reverb tail. Reverb settings are estimates.

## Synth before and after (warm idle, 786 rpm, behind the car)

| Measure | Real | Synth before | Synth after |
|---------|------|-------------|-------------|
| Energy above 500 Hz | 0.03% | 33% | 0.08% |
| Energy above 2 kHz | 0.008% | 22% | 0.05% |
| Cycle-energy variation (CV) | 0.138 | 0.06 | 0.149 |
| Half-order k=4 / k=5 re firing | -52 / -45 dB | -31 / -25 dB | -46 / -36 dB |
| Order k=16 (2x firing) | -16 dB | -13 dB | -21 dB |
| Idle | 786 rpm | 650 rpm | 785 rpm |

## Changes made because of the data

Engine model (`engine-dsp.js`, `engine-data.json`):

1. Pulse noise (rasp) scales with the square of load: an idling pulse is nearly clean.
2. Pulses rise more slowly at light load (low cylinder pressure at valve opening), and the
   rise has two smooth stages, which rolls idle harmonics off at the real engine's rate.
3. Cycle variation is a slow drift (correlated over about ten firings) plus small
   per-firing jitter; per-cylinder trim reduced from +/-6% to +/-1.5%.
4. Cold start: the measured idle curve and catalyst-heating level (`physics.coldStart`).
5. Pulse amplitude grows with rpm (gas velocity). Before this, total exhaust power barely
   changed with revs and intake noise was carrying full-throttle loudness.
6. Split exhaust routing conserves power (true dual was 5 dB too quiet).
7. The sport muffler's tailpipe resonance lowered from 0.42 to 0.20: the stronger value
   made the synth 7 dB quieter at the 1,150 rpm fast idle than at 786 rpm, which the real
   car does not do. 0.12 fitted this take best; 0.20 is a compromise because ten presets
   share that muffler and this is one car.
8. S65 preset: idle 785 rpm, single collector.

Listening positions (`perspectives` in `engine-data.json`): source balance, ground
reflection, octave EQ, small reverb, width, level. The EQ of the three measured positions
is one smooth tilt above 250 Hz, fitted only on bands with at least 10 dB SNR:

| Position | Basis | Tilt above 250 Hz | Residual |
|----------|-------|-------------------|----------|
| Behind the car | STE-035, catalyst-heating stretch 68-84 s at 786 rpm | -0.2 dB/oct | 2.2 dB over 5 bands |
| In front, at the intake | STE-036, 52-75 s | -3.2 dB/oct | 5.5 dB over 7 bands |
| Engine bay, hood open | STE-037, 35-78 s | -2.6 dB/oct | 4.9 dB over 8 bands |
| Driver's seat | Estimated, no recording | hand-set | - |
| Dry model | The raw synth | flat | - |

All positions are level-matched at full throttle so switching changes character, not
volume. The fit was re-run (same day) after the load-dependent changes calibrated against Gran
Turismo's recordings (darker individual throttle bodies, block noise, per-cylinder
differences); the figures above are that refit. Before it: behind -0.6 dB/oct, 1.5 dB; in
front -3.8 dB/oct, 6.0 dB; in the bay -3.2 dB/oct, 5.6 dB.

## Mistakes caught on the way

- A free 10-band EQ fit at idle carved -23 dB at 500 Hz, which at 8,000 rpm is the S65's
  firing frequency. One idle recording cannot separate the engine from the listening path,
  so the path is limited to one tilt and the rest is treated as an engine-model error.
- Matching level at idle pushed full throttle into the soft clipper; matching against
  the dry model's total (dominated by intake roar under load) inflated the rear level x22.
- The fit's write-back overwrote every perspective below the one it fitted, including the
  "dry" reference it measured against. Fixed; it now edits one block and asserts it.

## Still unmatched


- A broadband floor in the 250-500 Hz octave about 17 dB above the real idle (order 32 at
  -37 dB against -54 dB).
- During the cold fast idle the synth is about 4.5 dB quieter than the real car relative
  to warm idle; the cause is not identified.
- Full throttle is uncalibrated: from behind, the synth is only about 7 dB louder at
  7,000 rpm than at idle. A recording of a rev sweep and a pull, with the same mic
  positions, is what would settle that.
