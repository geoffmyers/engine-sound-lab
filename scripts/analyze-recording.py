#!/usr/bin/env python3
"""Measure an engine recording (real or synthesized) the same way, so they can be compared.

Per WAV, over a chosen time window of steady running:
  - engine speed, tracked from the FIRING frequency (rpm/60 x cylinders/2 for a 4-stroke):
    the candidate whose comb f, 2f, 3f collects the most energy above its in-between
    points. (A half-order comb was tried first and locked onto octave errors.)
  - the engine-order spectrum: level of each half-order k = 1..32 relative to the firing
    order (k = cylinders), the fingerprint of firing order, bank layout and exhaust;
  - the long-term average spectrum in 1/6-octave bands, normalised to 0 dB total power,
    so different mic positions and gains compare by SHAPE;
  - cycle-to-cycle variation: the coefficient of variation of energy per engine cycle
    (720 degrees), the steadiness or lope of the idle;
  - level and the share of energy below 30 Hz (handling noise, wind, vibration).

Usage:
  analyze-recording.py OUT.json --cylinders 8 --rpm 500:2500 --hp 30 \
      LABEL=path.wav@START-END [LABEL=path.wav@START-END ...]
Prints a comparison table and writes every measurement to OUT.json.
"""
import argparse
import json
import sys
import warnings

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfiltfilt, stft

warnings.filterwarnings("ignore", category=wavfile.WavFileWarning)


def load(path, t0, t1):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if np.abs(x).max() > 1.5:
        x /= 32768.0
    if x.ndim == 2:
        x = x.mean(axis=1)
    return sr, x[int(t0 * sr):int(t1 * sr)]


def track_firing(x, sr, cyl, rpm_lo, rpm_hi, hop=0.25):
    nwin = int(sr * 1.0)
    f, t, Z = stft(x, fs=sr, nperseg=nwin, noverlap=nwin - int(sr * hop), window="hann", boundary=None)
    L = np.log10(np.abs(Z) + 1e-12)
    df = f[1] - f[0]
    cands = np.arange(rpm_lo, rpm_hi + 1, 2.0) / 60 * cyl / 2
    best = np.zeros(L.shape[1]); score = np.full(L.shape[1], -1e9)
    for ff in cands:
        on = sum(L[int(round(k * ff / df)), :] for k in (1, 2, 3)) / 3
        off = sum(L[int(round((k + 0.5) * ff / df)), :] for k in (1, 2)) / 2
        sc = on - off
        b = sc > score
        best[b] = ff; score[b] = sc[b]
    rpm = best * 60 * 2 / cyl
    return t, rpm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("items", nargs="+")
    ap.add_argument("--cylinders", type=int, default=8)
    ap.add_argument("--rpm", default="500:2500")
    ap.add_argument("--hp", type=float, default=30.0, help="high-pass (Hz) before measuring shape and cycle variation")
    a = ap.parse_args()
    rlo, rhi = (float(v) for v in a.rpm.split(":"))
    cyl = a.cylinders
    results = {}

    for item in a.items:
        label, rest = item.split("=", 1)
        path, span = rest.rsplit("@", 1)
        t0, t1 = (float(v) for v in span.split("-"))
        sr, x = load(path, t0, t1)
        raw_rms = np.sqrt((x ** 2).mean())
        sos = butter(4, a.hp, "highpass", fs=sr, output="sos")
        xh = sosfiltfilt(sos, x)
        low_share = 1 - (xh ** 2).mean() / max((x ** 2).mean(), 1e-20)

        t, rpm = track_firing(xh, sr, cyl, rlo, rhi)
        rpm_med = float(np.median(rpm))

        # Order spectrum from one long FFT at the median speed (the window is steady).
        w = np.hanning(len(xh)); F = np.abs(np.fft.rfft(xh * w)); f = np.fft.rfftfreq(len(xh), 1 / sr)
        df = f[1] - f[0]
        fc = rpm_med / 120.0  # cycle frequency, half-order 1
        spread = max(2, int(round(0.012 * rpm_med / 60 / df)))  # allow for rpm wander
        ords = []
        for k in range(1, 33):
            i = int(round(k * fc / df))
            ords.append(F[max(0, i - spread):i + spread + 1].max())
        ords = np.array(ords)
        order_db = (20 * np.log10(ords / ords[cyl - 1])).round(1)

        # Long-term average spectrum, 1/6 octave, normalised to total power.
        edges = 25 * 2 ** (np.arange(0, 6 * np.log2(16000 / 25) + 2) / 6)
        P = F ** 2; tot = P[(f >= 25) & (f < 16000)].sum()
        ltas = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (f >= lo) & (f < hi)
            if m.any():
                ltas.append([round(float(np.sqrt(lo * hi)), 1), round(float(10 * np.log10(P[m].sum() / tot + 1e-20)), 1)])

        # Energy per engine cycle (720 degrees) and its variation.
        cyc = int(sr * 120 / rpm_med)
        n = len(xh) // cyc
        e = np.array([(xh[i * cyc:(i + 1) * cyc] ** 2).sum() for i in range(n)])
        cv = float(e.std() / e.mean()) if n > 4 else None

        # Brightness: share of energy above 500 Hz and above 2 kHz.
        hi500 = float(P[f > 500].sum() / tot); hi2k = float(P[f > 2000].sum() / tot)

        results[label] = {
            "file": path, "window_s": [t0, t1],
            "rms_dbfs": round(float(20 * np.log10(raw_rms + 1e-12)), 1),
            "energy_below_hp_pct": round(100 * low_share, 1),
            "rpm_median": round(rpm_med), "rpm_p10_p90": [round(float(np.percentile(rpm, 10))), round(float(np.percentile(rpm, 90)))],
            "firing_hz": round(rpm_med / 60 * cyl / 2, 1),
            "order_db_k1_32": order_db.tolist(),
            "ltas_sixth_octave": ltas,
            "cycle_energy_cv": round(cv, 3) if cv is not None else None,
            "energy_above_500hz_pct": round(100 * hi500, 2), "energy_above_2khz_pct": round(100 * hi2k, 3),
        }

    with open(a.out, "w") as fh:
        json.dump(results, fh, indent=1)

    labels = list(results)
    print(f"{'':28s}" + "".join(f"{l:>14s}" for l in labels))
    for key, fmt in [("rpm_median", "{}"), ("firing_hz", "{}"), ("rms_dbfs", "{}"), ("energy_below_hp_pct", "{}%"),
                     ("cycle_energy_cv", "{}"), ("energy_above_500hz_pct", "{}%"), ("energy_above_2khz_pct", "{}%")]:
        print(f"{key:28s}" + "".join(f"{fmt.format(results[l][key]):>14s}" for l in labels))
    print("\nhalf-order level, dB re firing order (k = cylinders):")
    for k in list(range(1, 2 * cyl + 1)) + [3 * cyl, 4 * cyl]:
        if k <= 32:
            print(f"  k={k:<3d}{'(firing)' if k == cyl else '':9s}" + "".join(f"{results[l]['order_db_k1_32'][k - 1]:>14.1f}" for l in labels))
    print("\nLTAS shape, dB of total power, standard 1/3-octave bands:")
    for fc in (40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 3150, 5000, 8000):
        row = []
        for l in labels:
            p = sum(10 ** (b[1] / 10) for b in results[l]["ltas_sixth_octave"] if fc * 2 ** (-1 / 6) <= b[0] < fc * 2 ** (1 / 6))
            row.append(10 * np.log10(p + 1e-20))
        print(f"  {fc:>5d} Hz" + " " * 19 + "".join(f"{v:>14.1f}" for v in row))

if __name__ == "__main__":
    sys.exit(main())
