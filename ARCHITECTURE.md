# Architecture

Engine Sound Lab is a static page: `index.html` loads `app.js` as an ES module, which starts
an AudioWorklet (`engine-worklet.js`) running the synthesizer. The synthesizer and the
drivetrain are plain JavaScript with no Web Audio dependency (`engine-dsp.js`,
`drivetrain.js`, `dsp-util.js`), so the same code renders offline in the page's WAV export
and runs under Node in the tests. Everything numeric (layouts and firing angles, mufflers,
intakes, superchargers, vehicles, listening positions, presets) lives in `engine-data.json`;
`engine-config.js` turns a preset plus the user's edits into the numbers the DSP runs on.

## How the sound is made

Everything is synthesized; there are no samples.

| Stage | What it models |
|-------|----------------|
| Crank | The crank angle advances every sample at the current rpm, with a compression and per-firing speed ripple (the idle "chug", the lope of a big cam). |
| Firing | Each cylinder fires at its own angle from `engine-data.json` (a 720° cycle, or 360° of eccentric shaft for a rotary). A firing makes an exhaust blowdown pulse: fast rise, decay set by the valve-open time at this rpm, a tail for the exhaust stroke, turbulent noise that grows with load. Combustion varies cycle to cycle. |
| Headers | Each cylinder's pulse is delayed by its runner length: equal, unequal (the boxer rumble) or a log manifold. |
| Banks and routing | Two-bank engines keep two exhaust streams: one collector, an X-pipe, or true dual (bank A left speaker, bank B right). This is why a cross-plane V8 burbles (each bank fires 90-180-270-180°) and a flat-plane V8 does not. |
| Exhaust system | Turbine damping (more spool, more muffled), catalyst, a muffler chamber resonance, the tailpipe as a delay-line waveguide whose open end reflects inverted, the muffler's low-pass, then tailpipe radiation. |
| Intake | Intake-stroke pulses ring the airbox's Helmholtz resonance, plus induction roar; individual throttle bodies are loud and raspy. |
| Extras | Valve seating clicks, diesel combustion clatter, turbo whistle and hiss, blow-off valve (vented, recirculating, or compressor-surge flutter with none), supercharger whine at its lobe frequency (Roots, twin-screw) or impeller speed (centrifugal), starter motor. |
| Physics | Throttle plate lag, idle air control, manifold load, torque curve, friction and pumping losses, flywheel inertia, hard-cut rev limiter, deceleration fuel cut with afterfire pops (scaled by their own mixer channel, `mix.pops`, before the exhaust path), turbo spool and lag, a six-speed gearbox with shifts at the limiter. |

All layout, hardware, gearing, scenario and preset numbers live in `engine-data.json`; the
code holds none of its own.

## Real vehicles and engines

42 presets reproduce real vehicles' engine and drivetrain configurations, grouped on the
page as road cars (Porsche 911 GT3, Ferrari 458, Lexus LFA, Corvette C8, Mustang GT, Hellcat,
GT-R, S2000, Civic Type R, RX-7, Supra, STI, RS3, E46 M3, SLS AMG, Aventador, GR86, MX-5,
Beetle, Model T), race cars (2005 Renault R25 V10, 2006 Cosworth F1 V8, Ferrari 412 T2 V12,
NASCAR Next Gen, Mazda 787B four-rotor, Audi S1 E2, Audi R10 TDI, 911 GT3 Cup, IndyCar,
Top Fuel dragster, Yamaha M1), motorcycles (Harley Milwaukee-Eight, Ducati Panigale V4,
Hayabusa, KTM 250 SX two-stroke), aircraft (Merlin with propeller reduction, R-1340 Wasp
radial, Lycoming O-360) and machines (Ram Cummins, Detroit Diesel 8V-71 two-stroke,
Stihl chainsaw, Briggs & Stratton mower).

Each preset carries its real layout, displacement, rev limit, firing order and bank
numbering where published, aspiration, gearbox type and gear count, ratios, final drive,
mass and tyre size. The page shows a one-line spec under the engine with links to the
sources, and lists every estimated value.

- **Research** (`research/2026-11-15-*.json`): what was found per vehicle, with sources,
  notes on conflicts, and null where nothing was found.
- **Modelling** (`research/preset-modelling.json`): which research entry each preset uses,
  its layout, the sound-modelling choices, estimates for every null (each with a reason),
  and overrides where the research is right but in a different convention (the Corvette's
  3.55 is ring-and-pinion only, overall 5.17; the S2000's 4.100 times its 1.160 secondary).
- **Generator**: `python3 scripts/build-real-presets.py` writes the presets and vehicles
  into `engine-data.json` (only entries marked `"real": true`); `--check` fails if the file
  is stale. Never edit real presets in `engine-data.json` by hand.

What this added to the engine model: two-stroke cycles (one firing per revolution, ports
without valve clicks unless the engine has exhaust valves like the Detroit), a nine-cylinder
radial (and its diagram), a four-rotor Wankel, an even-fire 90° V6, published firing orders
per preset, propellers (load rising with the square of speed so full throttle settles near
rated rpm, plus a blade-pass tone and a tip rasp near Mach 1), engines with no wheels (Drive
disabled), and launch clutch control that slips to hold the engine near a launch speed.
Race gearboxes are secret and track-dependent, so their ratios are spread to the car's
known top speed at the rev limit and marked as estimated.

### Torque, power and acceleration

Each real preset's full-throttle torque curve is calibrated to its published figures: peak
torque at its rpm and peak power at its rpm (derived by a stated rule, and labelled, where
only one is published). The curve passes through those points with a monotone cubic, and
the steady full-throttle boost and the engine friction are divided back out, so the net
crank torque at full throttle reproduces the figures while turbo lag and part throttle
still act through manifold load. Generic presets keep a per-litre estimate.

Acceleration then comes from that torque through the clutch, gear ratios and final drive
against mass, drag and rolling resistance. The tyres have full traction, deliberately: no
wheelspin and no wheelies are simulated, so whatever torque the clutch passes moves the car.
A two-pedal launch control holds the clutch and launch rpm under brake and full throttle.
Automatic upshifts follow road speed, not an engine racing ahead on a slipping clutch.

`node scripts/check-acceleration.mjs` (part of `npm run check`) verifies every real preset:
peak torque within 3% and peak power within 4% of its spec, and the DSP's boost within 3% of
the formula the calibration assumes. It also runs 0-60 mph magazine style (launch control,
first foot of roll-out excluded) against the sourced times in
`research/2026-11-15-acceleration.json`, but one way only: with perfect traction a car beats
its grip-limited real time (on 2026-11-15 by 15-40%: a GT3 2.1 s against 2.7 s), so only a
car more than 25% SLOWER than its real time fails, which would mean wrong torque, gearing or
shifts.

## Driving: clutch, gearbox, car, brakes

**Drive** mode puts the engine in a vehicle (`drivetrain.js`; data under `drivetrain`,
`transmissions` and `gearCuts` in `engine-data.json`). Engine and car are coupled through a
clutch that slips or locks: locked, engine and car move as one inertia; slipping, the
clutch passes at most its capacity. The car has mass, aerodynamic drag, rolling resistance
and brakes. Five vehicles: the E9x M3 (its real six-speed ratios and final drive), a
single-seater race car, a sport bike, a cruiser and a dirt bike; the motorcycle presets use
the bikes. An automatic clutch launches from rest and lets go before the engine can stall.

Controls: brake pedal and `B`; shift paddles, `↑`/`E` and `↓`/`Q`. Shifting is automatic
or by hand; a downshift that would over-rev is refused with a message. Automatic shifting
is racing style (`autoShift` in `engine-data.json`): up at the limiter under throttle, and,
off the throttle or braking, down the moment the next gear would stay under 99% of the
redline, rev-matched. It never downshifts under throttle, which would undo the upshift
it just made.

| Gearbox | Upshift | Downshift |
|---------|---------|-----------|
| Manual, H-pattern | Clutch out, lever to neutral (click), synchro whirr while the input shaft is dragged to the new speed, clunk, clutch in | Same, with an optional rev-match blip |
| Sequential dog box | Ignition cut (with afterfire crackle) while the dog ring slams across: clack | Automatic blip, dog clack |
| Dual-clutch | Ignition cut and a quick clutch handover | Automatic blip, handover |

**Gear noise** is synthesized from the shafts' real speeds. Whine sits at input-shaft
revolutions × mesh events per revolution for the loaded gear pair and for the constant-mesh
head set, plus the final-drive pinion; tooth-spacing errors give sidebands at shaft rate.
Mesh counts are derived from the box's geometry (a pair on a fixed centre distance has a
constant tooth sum), so the whine steps UP in pitch on each upshift even as the revs drop,
and a car box's direct-drive gear (1.000) has no loaded pair at all. **Straight-cut** gears
whine loudly with strong harmonics; **helical** gears are about 20 dB quieter and nearly
pure. Unloaded gears rattle on each firing (neutral at idle, coasting), straight-cut far
more. Torque reversals shunt the driveline. Road and wind noise grow with speed. All of it
goes through the listening position (strongest in the driver's seat).

## Listening positions and calibration against a real engine

**Listening position** sets what reaches the listener: the balance of exhaust, intake,
mechanical and turbo/blower sound, a ground reflection, an octave EQ, a small reverb,
stereo width and level (`perspectives` in `engine-data.json`). Behind the car, at the
intake and in the engine bay are **fitted to recordings** of the author's BMW S65; the driver's
seat is **estimated**; the dry model is the raw synth. The page labels each one.

The same recordings calibrated the engine itself at idle: harmonic roll-off, rasp at
light load, cycle-to-cycle variation, and a **cold start** (idle curve and catalyst-heating
loudness) offered as a checkbox. Findings, before/after numbers, mistakes caught and what
is still unmatched: [docs/2026-11-15-s65-recording-analysis.md](docs/2026-11-15-s65-recording-analysis.md).

Those recordings are of an idling car only. Under load, the synth was measured against the
engine recordings in Gran Turismo 5, 6 and 7 for every preset whose engine (or the nearest one)
the games recorded: 22 presets, with GT7's five microphones per engine checking all four
listening positions. What changed from it:

- **Cylinder-to-cylinder differences grow with load and speed** (`physics.loadUnevenness`):
  each cylinder's exhaust and intake pulse differs a little in strength and arrival, scaled by
  load and rpm, so the half orders rise from about -28 dB at idle to about -10 dB at full load
  near the limit, as in GT7, where the synth had been a near-pure firing tone. The pattern
  carries none of the once- or twice-per-cycle variation, which would pile its energy into the
  lowest octave; intake pulses get twice the difference (GT7's intake microphones hear stronger
  half orders than its exhaust ones).
- **Block-radiated combustion noise** (`physics.blockNoise`, with its own weight per position,
  `sources.block`): a short burst per firing that grows with load, which an engine bay hears
  whatever the intake. Without it, engines with an airbox or cone filter had bays up to 2.5
  octaves darker than GT7's.
- **The supercharger's whine radiates from its inlet** (`sources.blower`): loud at the intake,
  much quieter in the bay, the cabin and behind the car, matching GT7's Hellcat at all four
  within 1 dB. The Hellcat's drive ratio comes from that recording (whine at 11.6x crank speed).
- **Individual throttle bodies are darker** (roar 2.1 to 1.3 kHz, rasp 0.6 to 0.35), and the
  **straight pipe is darker** (low-pass 8.5 to 3 kHz, rasp 0.7 to 0.5): both had made their
  engines 0.5 to 3 octaves too bright.

Each time, the measured positions were re-fitted to the S65 recordings
(`scripts/fit-perspectives.py`), so the idle still matches the real car. The comparison
tooling reads game data, so it is not part of this repository.

| Tool | Does |
|------|------|
| `scripts/analyze-recording.py` | Measures a real recording and a synth render the same way: rpm from the firing line, engine-order spectrum, 1/3-octave shape, cycle variation, brightness. |
| `scripts/render-preset.mjs` | Renders a preset at a given idle or held rpm, with any setting overridden. |
| `scripts/fit-perspectives.py` | Fits each measured position's EQ tilt (bands with >= 10 dB SNR only) and level, and writes them into `engine-data.json`. |

```bash
# with your three recordings in tests/out/ref/ (gitignored; the originals are not published)
python3 scripts/fit-perspectives.py tests/out/ref
python3 scripts/analyze-recording.py out.json --cylinders 8 --rpm 650:950 \
  real=tests/out/ref/rear-exhaust.wav@95-112 synth=synth.wav@4-16
```

## Files

| File | Role |
|------|------|
| `index.html` | The page (styles inline). |
| `app.js` | Controls, audio graph, tachometer, cylinder map, firing timeline, spectrum. |
| `engine-dsp.js` | The DSP and engine physics. Plain JS, no Web Audio, so it also runs under Node. |
| `drivetrain.js` | Clutch, gearbox, vehicle, brakes, shift sequencing, and gear, shift, road and wind sounds. |
| `dsp-util.js` | Filters, delay line and random numbers shared by the engine and the drivetrain. |
| `engine-worklet.js` | AudioWorklet wrapper. Without AudioWorklet (an insecure origin, an old browser) the page runs the same DSP through a ScriptProcessorNode. |
| `engine-config.js` | Resolves settings and `engine-data.json` into the DSP's numbers; layout analysis (firing order, intervals per bank, firing frequency). |
| `render.js` | Offline render of a scripted run plus a WAV encoder (the page's **Render WAV**, and the tests). |
| `engine-data.json` | Layouts with firing angles, mufflers, intakes, superchargers, gearing, scripted runs, presets, listening positions, cold-start data. Real-vehicle presets are generated. |
| `research/` | Sourced specifications of the real vehicles, and the modelling file the generator reads. |


## Tests

```bash
npm run check                        # every preset through the DSP, then the calibration checks
node tests/dsp-check.mjs tests/out   # the DSP checks, also writing idle / blips / pull WAVs

# Page smoke test against a Chromium started with --remote-debugging-port=9222. AudioWorklet
# needs a secure context: http://localhost counts; over plain HTTP elsewhere the page uses
# its ScriptProcessor fallback. Needs playwright-core (npm install playwright-core).
python3 -m http.server 8000
node tests/smoke.mjs http://localhost:8000/ tests/out
node scripts/capture-screenshots.mjs http://localhost:8000/ docs/screenshots
```

`dsp-check` fails on non-finite samples, an idle louder than full throttle, a pull that
never reaches the limiter, an idle that settles more than 12% off target, or (for
even-firing layouts) a firing frequency more than 12 dB below the strongest engine order,
if the S65's orders below the firing order are not clean at idle (under -20 dB) and between
-20 and -4 dB at full load near the limit, and if the Hellcat's supercharger whine stops
radiating mostly from the intake (at least 8 dB stronger there than in the bay).
The drivetrain checks: a pull reaches 4th and 120 km/h then brakes to a stop with
automatic downshifts and no stall; straight-cut is at least 10 dB louder than helical; the
whine stands at the predicted mesh frequency; an over-revving downshift is refused; the
sequential and dual-clutch boxes complete the run; manual shifting stays in neutral until
asked. `smoke` cold-starts the engine, revs it, tries every listening position, pulls a
turbo boxer away and through the gears, brakes, and checks a refused downshift's message.
