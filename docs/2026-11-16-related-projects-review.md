# Related open-source engine sound projects, reviewed for realism ideas

On 2026-11-16 the source of seven public projects was read (none was built or run) and compared
with `engine-dsp.js`, looking for what would close the gaps still measured against real
recordings:

- **4-8 kHz** is 3-7 dB above Gran Turismo 7's recordings behind the car and at the intake.
- **Half orders at the intake** are still about 6 dB too smooth high in the rev range.
- **A broadband floor at 250-500 Hz** sits about 17 dB above the real S65 at idle.
- **Full-throttle loudness grows too little:** from behind, the synth is only ~7 dB louder at
  7,000 rpm than at idle.

## The projects

| Project | Licence | What it is | Use to us |
|---|---|---|---|
| [ange-yaghi/engine-sim](https://github.com/ange-yaghi/engine-sim) | MIT | 0-D gas simulation per cylinder at 10 kHz; only exhaust-runner pressure is heard, then a 1.9 kHz low-pass, noise AM, a 10,000-tap recorded impulse response and an AGC | A few cheap tricks; most of its sound is physics we cannot afford on a phone plus a recorded IR we do not use |
| [zolaski333/EngineLab](https://github.com/zolaski333/EngineLab) | MIT | Quasi-1-D gas dynamics from valve to tailpipe, radiation to virtual microphones, blind listening against real recordings | Reduced-order effects and the best evaluation method of the group. Its own journal reports no engine recognisable beyond its cylinder count yet |
| [DasEtwas/enginesound](https://github.com/DasEtwas/enginesound), [Antonio-R1/engine-sound-generator](https://github.com/Antonio-R1/engine-sound-generator) | MIT | Baldan et al. 2015: per-cylinder waveguides whose valve ends are time-varying reflections, cylinders coupled through a shared collector | The valve-coupled runner is the one structural idea we lack. Both are rpm-only (no load) |
| [YigitSalihEmecen/Engine_Sim](https://github.com/YigitSalihEmecen/Engine_Sim) | none | Browser synth with a drivetrain; its `AGENT_CONTEXT.md` records measured findings | Richest list of tested ideas; no licence, so reimplement from the physics, never the code |
| [rdoerfler/ptr-model](https://github.com/rdoerfler/ptr-model), [prce-model](https://github.com/rdoerfler/prce-model) | CC BY-NC 4.0 | Neural pulse-train + Karplus-Strong resonators (EUSIPCO 2026) | Confirms our structure and unevenness size; one idea (temperature-dependent pitch). NonCommercial: ideas only, no code or data |
| [markeasting/engine-audio](https://github.com/markeasting/engine-audio) | MIT | Recorded loops cross-faded by rpm and throttle | Nothing: it synthesizes nothing |

## Already in Engine Sound Lab

Several things these projects do, we already do:

- **Exhaust pulse delays:** per-cylinder runner delays.
- **Combustion and speed variation:** cycle-to-cycle variation, crank-speed ripple and a speed
  bump.
- **Exhaust system:** a chamber plus a tailpipe with an inverted open-end reflection. This
  matches PTR's two resonator banks and engine-sim's per-cylinder delays.
- **Cylinder-to-cylinder differences:** per-cylinder unevenness at the same size PTR learned
  (±20° of crank).

Load dependence, turbo, blower and drivetrain coupling are beyond the Baldan-model projects
entirely.

## Ideas, ranked by realism gain per effort

### 1. Measure before changing (S)

Two of the four gaps trace to our own code, not to a missing technique:

- **The loudness growth is the rpm term.** `(0.3 + 0.7x)^0.9` in the exhaust pulse amplitude
  (`engine-dsp.js`, `trigger()`) is 0.41 at x = 0.1 and 1.0 at the redline: 7.7 dB, which is the
  measured 7 dB. Lowering the 0.3 floor (and re-fitting the perspective levels to idle) is the
  lever. No reviewed project solves this for us, and a loaded recording of the S65 is still what
  would set the right value.
- **The 250-500 Hz idle floor** is most likely our own noise:
  - the 0.01 minimum rasp in each pulse;
  - the per-firing `cv.fast` jitter;
  - the chamber feedback.

  Mute each one in turn to find it.

Before touching the 4-8 kHz excess, ablate `blockNoise` (centre 2.5 kHz, low-pass 7 kHz), the
intake rasp high-pass (1.6 kHz) and the valve clicks (3.9 kHz). EngineLab's lesson: **solo and
mute one layer at a time**, and check two offline renders are bit-identical so an A/B isolates
one stage.

**Block-rate comb check** (EngineLab `docs/thermoacoustic-architecture.md` §12). They found
"metallic" lines at exact multiples of their control-frame rate, which they caught by folding
the signal at the frame length. `process()` recomputes the turbo, hiss, blower and propeller
filter coefficients once per 128-sample block. Render a sweep offline and look for lines at
multiples of sr/128 (375 Hz at 48 kHz). If any show, ramp those parameters.

### 2. A radiation knee instead of an unbounded differentiator (S)

Three reviews arrived here independently:

- **Ours:** the tailpipe radiates `0.55y + 2.2·dy`, which rises +6 dB/octave above about 1.9 kHz
  with nothing to stop it.
- **Physics:** an open pipe radiates as a differentiator only while ka << 1, and flattens above
  roughly 2 kHz for a 60 mm pipe.
- **Engine_Sim** measured this as its "too high pitched" failure (V8 centroid 385 Hz at
  3,000 rpm with a pure derivative).
- **engine-sim** uses almost no derivative (0.01).
- **EngineLab** uses a Padé(1,2) fit of the Levine-Schwinger unflanged-pipe load
  (`PipeRadiationModel.hpp`), whose reflection also goes from -1 to 0 above ka ≈ 1.

Implementation: low-pass the `dy` term at a knee set from the tailpipe radius (a new
`exhaust.radiationKneeHz` or a radius in `engine-data.json`). The physical version is the Padé
biquad, which could also drive the open-end reflection. Cost is 4-10 flops per pipe per sample.
It is aimed straight at the 4-8 kHz excess (up to ~8 dB less at 5 kHz with a 2 kHz knee).

The perspective EQs were fitted at idle, where 4-8 kHz has under 10 dB SNR, so they never
constrained this band. Re-run `fit-perspectives.py`, then `compare.py` against GT7.

### 3. Band-limited pulse noise (S)

The turbulent rasp inside every pulse is one white sample per output sample
(`nz = rng.uni()`), so it reaches 22 kHz. engine-sim modulates with noise low-passed at 2 kHz.
One shared one-pole (2-4 kHz) on `nz` costs ~3 flops per sample and takes energy out of 4-8 kHz
without touching the firing harmonics. Do it together with idea 2 and re-fit once.

### 4. A flow-dependent jet-noise source (S)

From EngineLab `ExhaustJetNoise.cpp`: tailpipe jet noise has power ∝ U⁸ (pressure ∝ U⁴, about
12 dB per doubling of gas speed), a Strouhal-0.2 centre that rises with flow, and modulation by
the tailpipe flow. Our pulse noise grows only with load² and gently with speed.

Implementation: one band-pass biquad on noise with gain ∝ (load·rpm)⁴ and centre ∝ flow, added
before radiation, ~12 flops. It is silent at idle, which helps the idle floor, and steep at full
throttle, which helps the loudness growth. EngineLab admits its drive level is authored, so
calibrate the exponent against GT7 rather than trusting 8.

### 5. A valve-coupled intake runner per cylinder (M)

From the Baldan-model repos. Each runner is a short pair of fractional delay lines whose
cylinder end reflects with a coefficient driven by valve phase: about 0.9 closed, about 0.05
open, as a smoothstep with no trig. Its collector end is fed the sum of all runners, so each
cylinder's pulse is shaped by its own runner and by the others' returning waves.

Our existing INTAKE pulse stays the source, injected scaled by (1 − |r|), and the runners feed
the existing Helmholtz and roar filters. This is the most physical route to the missing intake
half orders. It costs about 130 flops per sample for a V8.

Keep the closed reflection at or below 0.7-0.9 (theirs at 0.95 rings) and use fractional
delays, not whole samples.

### 6. Exhaust back-pressure coupling (S, then M-L)

- **Cheap form:** at each exhaust firing, scale the pulse by `1 + k·(collector pressure now)`,
  read from the chamber delay line. It is one read per firing and gives pulse-to-pulse
  interaction and some rpm-dependent loudness bumps (pulse tuning).
- **Full form:** the Baldan valve-coupled exhaust runner with a collector return, ~150 flops per
  sample for a V8. It changes every preset's level and must be re-fitted to the S65 and GT7 data
  before it could replace the pulse → fixed chain. Keep the loop's round-trip gain under 0.9 with
  a smooth saturator; their hard clamp at 20 is a hack.

### 7. Gas temperature moves the pipe resonances (S)

Our `pipeD` and `chD` are fixed when the config loads, so the exhaust resonances never move.
The speed of sound goes as √T, 15-25% from idle to full load (PTR's "thermodynamic pitch",
Engine_Sim's gas temperature).

Implementation: a slow exhaust-temperature state (time constant of seconds, updated per block)
scales both delays (`DelayLine.read` is already fractional). It costs nothing per sample, and it
ties into the cold-start model: the note rises under load and sits lower when cold.

### 8. Level-dependent wave steepening (S, only after 2-3)

From EngineLab `NonlinearDuctAcoustics.hpp`: read the tailpipe delay at
`D / (1 + β·p'/ρc²)` with β = 1.175 for hot gas (clamped ±30%). It is passive and transparent at
low amplitude, so the idle stays clean while loaded pulses grow harmonics. EngineLab saw
1.5-4 kHz energy jump from 2.8% to 37.8% on its K20.

It adds highs, so it belongs on a darker base: once ideas 2-3 have darkened the static tilt,
steepening restores brightness with load only. It costs about 15 flops per pipe.

### 9. Runner length sets per-cylinder level (S, modest)

engine-sim attenuates each cylinder by 1/L² of its exhaust length, plus a fixed hand trim per
cylinder. That gives a deterministic, order-locked spread, which is what a half order is.

Our unequal-header delays do not change level. Adding the 1/L² term costs nothing per sample.
Expect a small effect: our hashed `uAmp` pattern is already fixed per cylinder.

## Character, not measured gaps

These do not close a measured gap, but each makes a familiar moment more convincing at no
per-sample cost:

- **Heat-gated afterfire** (Engine_Sim). An exhaust-temperature state rises over ~5 s and falls
  over ~26 s, and pops need it hot. Each pop is one of three gestures (crack, double, stutter),
  with a squared size draw (~27 dB spread against our ~9 dB) and a 0.45 s refractory time. Ours
  can pop while pottering and machine-guns on overrun.
- **Driveline shuffle** (Engine_Sim). Two inertias joined by a spring with lash, damping from
  c = 2ζ√(kJ). Tip-in and lift-off then wobble the engine speed at 6-25 Hz (lower gear, slower),
  and clunks scale as v^1.5 with fatigue. Ours is a fixed 55 Hz thump on a rigid driveline
  (`drivetrain.js`).
- **Compressor surge** (Engine_Sim). Each burst chirps down and the burst rate wanders. Ours is a
  fixed-rate flutter.
- **A small modal block radiator** (EngineLab `StructuralModalRadiator.hpp`). About 8 two-pole
  resonators, each cylinder driving each mode with its own signed weight: a physical source of
  half orders in the bay. The mode frequencies are unmeasured, so expect a modest gain.

## Not worth copying

- **A recorded impulse response** (engine-sim): needs a sample and a partitioned FFT in the
  worklet.
- **Automatic gain, leveler or auto-gain clipper** (engine-sim, EngineLab): flattens loudness
  growth, the opposite of our gap.
- **Random fractional-delay jitter** (engine-sim): smears the lines into broadband, which is not
  the order-locked half orders we lack.
- **A full finite-volume duct network** (EngineLab): below real time on a desktop for a V12.
- **Duct wall loss and mode cut-off** (EngineLab): 0.2-2.5 dB, and cut-off above 7 kHz. Too
  small to matter.
- **From the Baldan-model repos:**
  - the `cos(4πx)` piston term (a pure buzz);
  - fixed parallel muffler combs of 10-25 samples (metallic);
  - white noise times a valve window as the intake source;
  - whole-sample delays;
  - no load path at all.
- **Broadband loss inside a feedback loop** (EngineLab's lesson). Their 2 dB per pass erased an
  EJ25's fundamental (-11 dB), so re-tuning `chamberFeedback` must check the low end first.
- **PRCE's dataset:** synthetic, so it cannot validate realism. CC BY-NC as well.

## Evaluation to adopt (EngineLab `docs/audio-ab-listening.md`)

**Blind A/B clips:**
- Loudness-match each pair per ITU BS.1770 (-70 LUFS absolute gate, -10 LU relative), with
  20 ms fades.
- If a side would clip, attenuate both sides equally.
- Seed the A/B order, and keep the answer key apart from the clips.
- Collect 1-5 realism and preference scores plus a forced choice.
- Score with a Wilson 95% interval and an exact sign test.

**Two kinds of test:**
- **Against a real recording**, to rank deficits. No pass mark.
- **Against our own baseline**, as a non-regression gate: a change is accepted at ≥ 65%
  preference.

**Match each comparison to one condition.** Loudness-matching a clip that holds both idle and a
rev locks onto the loud part: EngineLab's idle looked 5 dB quiet only because of that.
`compare.py` already compares idle with idle and holds with holds.

**Beware summary metrics that rise for the wrong reason.** Spectral-shape correlation between
engines goes up when every engine gets brighter. Use these per-engine measures instead:
- the spread of third-octave shape across engines;
- the envelope modulation spectrum at idle;
- the sub-firing modulation ratio (our half-order metric).

A change tuned on one recording stays only if it does not move the others away from theirs.

## Suggested order

1. Ablation, the block-rate check and the loudness-growth term (idea 1).
2. Radiation knee and band-limited noise together (2, 3). Then re-fit the perspectives and run
   `compare.py`.
3. Jet noise (4) with the new growth law, calibrated against GT7 by speed bucket
   (`calibrate.py`).
4. Intake runner waveguides (5) on a branch, judged by the intake half orders.
5. Gas temperature (7), steepening (8), then the character items.

None of the reviewed projects has made an engine recognisable as a specific engine (EngineLab,
the most rigorous, says so itself). What separates Engine Sound Lab from all of them is fitting
to real recordings. The single most valuable input is still a recording of the S65 under load
(a rev sweep and a pull, at the same microphone positions), which would set the loudness-growth
and brightness-with-load terms that every idea above only approximates.

## Outcome (2026-11-16)

The cheap ideas, and the two gaps that traced to our own code, were implemented the same day.
Each change was checked against both references: Gran Turismo 7 under load (by speed bucket,
at all four positions), and the S65 idle, re-fitting the listening positions each time.

| Idea | Result |
|---|---|
| Loudness term (1) | Replaced by a law that conserves each pulse's charge (`physics.pulseFlow`): the S65 grows 18 dB from idle to a full-throttle pull, against 5 dB. It also fixed most of an old idle mismatch: the fast idle was 3.8 dB too quiet relative to warm idle, now 1.2 dB. Valve clicks, clatter, block noise, roar and gear rattle had to share the law, or the idle balance shifted toward them and the refit moved every position's EQ. |
| Idle floor at 250-500 Hz (1) | Not noise. Muting the rasp or the cycle variation moves it under 0.5 dB, and the real take has the same ratio between and on the orders. It is the idle pulse's shape in that octave; left open. |
| Block-rate check (1) | `scripts/block-rate-check.mjs`: no artefact. A first version compared two renders at single frequencies and reported random noise as lines; a fold shorter than a minute could not see -36 dB. The final check catches a sawtooth injected at -30 dB. |
| Radiation knee (2) | In, at 2 kHz (`physics.radiation`). Physically right. Once ideas 3 and the block noise were fixed it hardly mattered: little of the 4-8 kHz excess was the exhaust's. |
| Band-limited noise (3) | In, at 2 kHz, for the pulses and the intake roar. Without it, 8 kHz ran 4-7 dB higher under load. It also took away the 8-16 kHz ticking the real S65 has at idle, which **broadband valve clicks** (around 8 kHz, a constant strength) restored. |
| Jet noise (4) | Not implemented. Under load the synth's tonality (the share of energy on the engine orders) matches GT7's within 0.04 behind the car and at the intake. In the cabin the synth is 0.07-0.10 more tonal, and in the bay above 70% of the limit 0.13 less. There is no consistent shortfall of broadband noise for a jet-noise source to fill. |
| Not on the list | The **block noise** turned out to be the main source of 4-8 kHz under load at every position. Re-centred from 2.5 to 1.5 kHz, low-passed at 4.5 instead of 7 kHz. |

From behind the car under load, the 4 and 8 kHz octaves went from 4-10 dB above GT7 to
0.5-6 dB; in the bay to -3 to +3 dB and in the cabin to -5 to +2 dB. The S65 idle refit is
better at all three measured positions (1.2 / 5.4 / 4.4 dB rms against 2.2 / 5.5 / 4.9).

Still open:

- **Centroid behind the car and at the intake.** Over every GT7 loop under load it rose from
  +0.26 / +0.33 to +0.44 / +0.62 octave above GT7. The idle refit gave both positions brighter
  tilts, which lift 500 Hz-2 kHz.
- **The intake under load:** about 7 dB high at 4 kHz, and its 2 kHz octave rose.
- A plain idle pulse shape at 250-500 Hz.
- The half orders at the intake.

Every number here is a comparison with game recordings or one car's idle. A recording of the
S65 under load is still the missing reference.
