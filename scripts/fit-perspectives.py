#!/usr/bin/env python3
"""Fit each measured listener perspective's octave EQ to a real recording.

The perspective is the transfer path from the engine to the listener (body shielding,
distance, mic, ground); it does not change with rpm, so it can be fitted at one steady
operating point and applied everywhere. The engine itself (pulse shape, rasp, orders) must
already be right; an EQ can only reshape the average spectrum, never fix wrong harmonics.

A free 10-band fit at idle is NOT allowed: at idle every band above ~150 Hz holds only weak
harmonics and noise, so a free fit carves deep cuts there (it once cut 500 Hz by 23 dB),
and at 8,000 rpm the firing frequency lives in exactly that band. One idle recording
cannot separate source from path. So the path is constrained to what distance, body
shielding and air absorption produce: one smooth tilt, in dB per octave above 250 Hz,
fitted by least squares to the octave-band SHAPE difference (each spectrum normalised
to its own total power, so recorder gain does not matter). Whatever the tilt cannot
explain is reported as residual and belongs to the engine model, not the perspective.
'level': the rear perspective is set as loud as the dry model's exhaust alone at a LOADED point (60% of
the rev limit, 80% throttle). Matching at idle instead pushed full throttle into hard
saturation and squashed the idle-to-full-throttle range to 2.5 dB. The other measured
perspectives are then level-matched to the rear at full throttle, so switching position
changes the character, not the volume. (Their idle levels relative to the rear in the
recordings, -16 dB front and -11 dB bay, are recorded in engine-data.json; using them
directly left the front 15 dB quieter at full throttle.) The estimated cabin perspective
is level-matched the same way. Results are written back
into engine-data.json in place; everything else is untouched.

Usage: fit-perspectives.py REFDIR [--iters 6]
  REFDIR holds rear-exhaust.wav, front-intake.wav and engine-bay.wav (your own recordings: the
  originals are not in this repository; the windows in FITS below are for those takes).
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import warnings

import numpy as np
from scipy.signal import butter, sosfiltfilt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("ar", os.path.join(HERE, "analyze-recording.py"))
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
warnings.filterwarnings("ignore")

# perspective -> recording, steady running window, a silent window before the start (for
# per-band SNR), the measured idle rpm, and whether to fit against the synth's cold start.
# The rear take is fitted on the catalyst-heating stretch at warm idle speed (68-84 s):
# at warm idle (95-112 s) every band above 250 Hz sits 3-10 dB above the garage's ambient
# noise, so a fit there chased noise and carved it into the full-throttle sound.
FITS = {
    "rear": {"rec": "rear-exhaust.wav", "run": (68, 84), "quiet": (1, 7), "rpm": 786, "cold": True, "synth": (60, 74)},
    "front": {"rec": "front-intake.wav", "run": (52, 75), "quiet": (1, 8), "rpm": 786, "cold": False, "synth": (4, 14)},
    "bay": {"rec": "engine-bay.wav", "run": (35, 78), "quiet": (1, 9), "rpm": 786, "cold": False, "synth": (4, 14)},
}
MIN_SNR_DB = 10
PRESET = "bmw-s65"
CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
FIT_BANDS = range(1, 9)  # 63 Hz .. 8 kHz; below is handling noise, above is the noise floor


def band_power(path, t0, t1):
    sr, x = ar.load(path, t0, t1)
    x = sosfiltfilt(butter(4, 40, "highpass", fs=sr, output="sos"), x)
    F = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2 / len(x)
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return np.array([F[(f >= c / np.sqrt(2)) & (f < c * np.sqrt(2))].sum() for c in CENTERS]), x


def octave_shape(path, t0, t1):
    bands, x = band_power(path, t0, t1)
    tot = bands[list(FIT_BANDS)].sum()
    return 10 * np.log10(bands / tot + 1e-20), float(np.sqrt((x ** 2).mean()))


def render(patch, persp, rpm, out, hold=None, sets=(), seconds=14):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=os.path.dirname(out)) as fh:
        json.dump(patch, fh); pf = fh.name
    try:
        speed = ["--hold", str(hold), "--throttle", "0.8"] if hold else ["--idle", str(rpm)]
        subprocess.run(["node", os.path.join(HERE, "render-preset.mjs"), PRESET, out, *speed,
                        "--seconds", str(seconds), "--set", f"perspective={persp}", "--patch", pf,
                        *[a for kv in sets for a in ("--set", kv)]],
                       check=True, cwd=ROOT, capture_output=True)
    finally:
        os.unlink(pf)


def write_back(fitted):
    """Replace only the named perspectives' "eqDb" and "level" values, nothing else.

    Each perspective is one JSON object; find its key, then the FIRST eqDb and level after
    it. (An earlier version searched for a block end that matched only the last perspective,
    so every fit overwrote all the perspectives below it, including the reference "dry".)
    """
    path = os.path.join(ROOT, "engine-data.json")
    s = open(path).read()
    persp_at = s.index('"perspectives"')
    for persp, (eq, level) in fitted.items():
        start = s.index(f'"{persp}":', persp_at)
        m = re.compile(r'"eqDb": \[[^\]]*\]').search(s, start)
        s = s[:m.start()] + '"eqDb": [' + ", ".join(f"{v:.1f}" for v in eq) + "]" + s[m.end():]
        m = re.compile(r'"level": [0-9.]+').search(s, start)
        s = s[:m.start()] + f'"level": {level:.2f}' + s[m.end():]
    data = json.loads(s)
    for persp in fitted:
        assert data["perspectives"][persp]["level"] == round(fitted[persp][1], 2)
    open(path, "w").write(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("refdir")
    a = ap.parse_args()
    work = os.path.join(a.refdir, "fit"); os.makedirs(work, exist_ok=True)
    data = json.load(open(os.path.join(ROOT, "engine-data.json")))

    # Loudness reference: the dry model's EXHAUST alone under load. (Its total is dominated
    # by intake roar and mechanical noise under load, which made the rear level x22.)
    redline = next(p["redline"] for p in data["presets"] if p["id"] == PRESET)
    ref_rpm = round(0.6 * redline)
    dry = os.path.join(work, "dry.wav")
    render({}, "dry", 786, dry, hold=ref_rpm, sets=("mix.intake=0", "mix.mechanical=0", "mix.induction=0"))
    _, dry_rms = octave_shape(dry, 4, 14)

    fitted = {}
    for persp, fit in FITS.items():
        rec = os.path.join(a.refdir, fit["rec"]); rpm = fit["rpm"]
        target, rec_rms = octave_shape(rec, *fit["run"])
        run_p, _ = band_power(rec, *fit["run"]); quiet_p, _ = band_power(rec, *fit["quiet"])
        dur = lambda w: w[1] - w[0]
        snr = 10 * np.log10((run_p / dur(fit["run"])) / (quiet_p / dur(fit["quiet"]) + 1e-30))
        usable = [b for b in FIT_BANDS if snr[b] >= MIN_SNR_DB]
        out = os.path.join(work, f"{persp}.wav")
        sets = ("coldStart=true",) if fit["cold"] else ()
        secs = fit["synth"][1] + 1
        # Shape with no EQ, then the least-squares tilt above 250 Hz over the usable bands.
        render({"perspectives": {persp: {"eqDb": [0] * len(CENTERS), "level": 1.0}}}, persp, rpm, out, sets=sets, seconds=secs)
        shape0, _ = octave_shape(out, *fit["synth"])
        err0 = target - shape0
        idx = [b for b in usable if CENTERS[b] > 250]
        L = np.array([np.log2(CENTERS[b] / 250) for b in idx])
        slope = float(np.clip((err0[idx] * L).sum() / (L * L).sum(), -12, 3)) if idx else 0.0
        eq = np.array([slope * max(0.0, np.log2(c / 250)) for c in CENTERS]).clip(-36, 12)
        render({"perspectives": {persp: {"eqDb": eq.round(2).tolist(), "level": 1.0}}}, persp, rpm, out, sets=sets, seconds=secs)
        shape, rms = octave_shape(out, *fit["synth"])
        err = target - shape
        resid = float(np.sqrt(np.mean(err[usable] ** 2)))
        if fit["cold"]:
            # Level is set against a warm idle; re-measure this perspective warm.
            warm = os.path.join(work, f"{persp}-warm.wav")
            render({"perspectives": {persp: {"eqDb": eq.round(2).tolist(), "level": 1.0}}}, persp, rpm, warm)
            _, rms = octave_shape(warm, 4, 14)
            _, rec_rms = octave_shape(rec, 95, 112)
        if persp == "rear":
            loaded = os.path.join(work, f"{persp}-loaded.wav")
            render({"perspectives": {persp: {"eqDb": eq.round(2).tolist(), "level": 1.0}}}, persp, rpm, loaded, hold=ref_rpm)
            _, loaded_rms = octave_shape(loaded, 4, 14)
            level = float(np.clip(dry_rms / max(loaded_rms, 1e-9), 0.1, 40))
            rear_ref = (level, rms, rec_rms)
        else:
            r_level, r_idle, r_rec = rear_ref
            level = float(np.clip(r_level * (r_idle / rms) * (rec_rms / r_rec), 0.1, 40))
        fitted[persp] = (eq, level)
        print(f"{persp:6s} tilt {slope:5.1f} dB/oct above 250 Hz, level {level:.2f}, residual {resid:4.1f} dB rms over {len(usable)} usable bands")
        print("       band   " + " ".join(f"{c:>6g}" for c in CENTERS))
        print("       target " + " ".join(f"{v:6.1f}" for v in target) + "\n       synth  " + " ".join(f"{v:6.1f}" for v in shape))
        print("       error  " + " ".join(f"{v:6.1f}" for v in err))
        print("       SNR    " + " ".join(f"{v:6.1f}" for v in snr) + f"   (bands under {MIN_SNR_DB} dB not fitted)")
    # Equal loudness at full throttle (85% of the rev limit, steady) against the rear.
    def wot_rms(persp, eq, level):
        out = os.path.join(work, f"{persp}-wot.wav")
        patch = {"perspectives": {persp: {"level": level}}}
        if eq is not None:
            patch["perspectives"][persp]["eqDb"] = eq.round(2).tolist()
        render(patch, persp, 786, out, hold=round(0.85 * redline))
        return octave_shape(out, 4, 14)[1]
    rear_eq, rear_level = fitted["rear"]
    target_rms = wot_rms("rear", rear_eq, rear_level)
    for persp in ["front", "bay", "cabin"]:
        eq, level = fitted.get(persp, (None, data["perspectives"][persp]["level"]))
        level = float(np.clip(level * target_rms / wot_rms(persp, eq, level), 0.05, 40))
        fitted[persp] = (eq if eq is not None else np.array(data["perspectives"][persp]["eqDb"], float), level)
        print(f"{persp:6s} level matched at full throttle: {level:.2f}")
    write_back(fitted)
    print("engine-data.json updated")


if __name__ == "__main__":
    sys.exit(main())
