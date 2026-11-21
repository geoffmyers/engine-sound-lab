#!/usr/bin/env python3
"""Build the real-vehicle presets in engine-data.json from sourced research.

Inputs (committed beside this script):
  research/*.json                    what research found, one object per vehicle, with sources
                                     and notes; null where nothing was found
  research/preset-modelling.json     per preset: which research entry it uses, the layout it
                                     maps to, the synthesizer's modelling choices (intake,
                                     muffler, cam, pops...), and ESTIMATES for anything the
                                     research left null, each with its reason

Every number a preset carries comes from the research unless it is listed in the preset's
"estimated" array; the page prints that list next to the sources. Real-vehicle presets and
vehicles are replaced wholesale on each run (they carry "real": true); hand-written presets
and vehicles are left alone.

Usage: build-real-presets.py [--check]   (--check: exit 1 if engine-data.json is stale)
"""
import argparse
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RESEARCH = os.path.join(ROOT, "research")

# Defaults by category for what research rarely publishes; each use is recorded as an estimate.
DEFAULT_CDA = {"road": 0.65, "race": 0.9, "motorcycle": 0.35, "machine": 1.6}
DEFAULT_CRR = {"road": 0.012, "race": 0.015, "motorcycle": 0.015, "machine": 0.008}
DEFAULT_BRAKE = {"road": 9.5, "race": 15.0, "motorcycle": 9.5, "machine": 6.0}
ADD_DRIVER_KG = {"road": 75, "machine": 75, "motorcycle": 80, "race": 0}


def tyre_radius(t):
    """Rolling radius in metres from a tyre size string, or None."""
    if not t:
        return None
    m = re.search(r"(\d{3})\s*/\s*(\d{2})\s*[A-Z]*\s*(\d{2})", t)             # 285/35ZRF20, 150/80B16
    if m:
        w, a, rim = map(float, m.groups())
        return round((rim * 25.4 / 2 + w * a / 100) / 1000, 3)
    m = re.search(r"(\d{2,3})\s*/\s*(\d{2,3})\s*-\s*(\d{2})", t)               # 31/71-18 (cm), 330/700
    if m:
        w, d, rim = map(float, m.groups())
        if w >= 60:   # 110/90-19: millimetre width / aspect ratio - rim (motorcycles)
            return round((rim * 25.4 / 2 + w * d / 100) / 1000, 3)
        return round(d / 200 if d < 100 else d / 2000, 3)   # 31/71-18: cm width / cm diameter
    m = re.search(r"(\d{3})\s*-\s*(\d{3})\s*[xX]\s*(\d{2})", t)                 # 330-700x17
    if m:
        return round(float(m.group(2)) / 2000, 3)
    m = re.search(r"(\d+(?:\.\d+)?)\s*-\s*(\d{2})\b", t)                        # 5.60-15 (inches)
    if m:
        sec, rim = map(float, m.groups())
        return round((rim / 2 + sec * 0.92) * 0.0254, 3)
    return None


def load_research():
    out = {}
    for f in sorted(os.listdir(RESEARCH)):
        if f.endswith(".json") and not f.startswith("preset-") and "acceleration" not in f:
            for item in json.load(open(os.path.join(RESEARCH, f))):
                out[item["id"]] = item
    return out


def first(*vals):
    for v in vals:
        if v not in (None, "", [], {}):
            return v
    return None


def geometric_ratios(n, top, spread):
    """n overall ratios from top*spread down to top, evenly spaced on a log scale."""
    if n == 1:
        return [top]
    k = spread ** (1 / (n - 1))
    return [round(top * k ** (n - 1 - i), 3) for i in range(n)]


def torque_spec(e, est, p, estimated):
    """Peak torque (N·m at rpm) and peak power (kW at rpm) for the engine's torque curve.

    Researched figures first, then explicit estimates from the modelling file, then two
    derivation rules, each recorded in "estimated": torque from power (peak torque about
    1.1 x the torque at peak power, at 75% of the power rpm) and power from torque (at 90%
    of the rev limit, 85% of peak torque there).
    """
    w = lambda rpm: rpm * 2 * math.pi / 60
    def get(field, research_key, label):
        v = e.get(research_key)
        if v not in (None, ""):
            return v
        if field in est:
            estimated.append(label)
            return est[field]
        return None
    kw = get("powerKw", "powerKw", "peak power")
    kwr = get("powerRpm", "powerRpm", "power rpm")
    nm = get("peakNm", "torqueNm", "peak torque")
    nmr = get("peakRpm", "torqueRpm", "torque rpm")
    R = p["redline"]
    if kw and not kwr:
        kwr = round(0.92 * R); estimated.append("power rpm (92% of the limit)")
    if kw and not nm:
        nm = round(1.1 * kw * 1000 / w(kwr)); nmr = nmr or round(0.75 * kwr)
        estimated.append("peak torque (derived from power)")
    if nm and not nmr:
        nmr = round(0.45 * R if p.get("aspiration") == "turbo" else 0.7 * (kwr or R)); estimated.append("torque rpm")
    if nm and not kw:
        kwr = round(0.9 * R); kw = round(0.85 * nm * w(kwr) / 1000, 1)
        estimated.append("peak power (derived from torque)")
    if not (kw and nm):
        raise SystemExit(f"{p['id']}: no power or torque figures and no estimates")
    return {"peakNm": nm, "peakRpm": nmr, "powerKw": kw, "powerRpm": kwr}


def build(model, research):
    presets, vehicles = [], {}
    for m in model["presets"]:
        r = research.get(m["research"]) if m.get("research") else None
        if m.get("research") and r is None:
            raise SystemExit(f"{m['id']}: research entry {m['research']} not found")
        e = (r or {}).get("engine", {})
        t = (r or {}).get("transmission", {})
        v = (r or {}).get("vehicle", {})
        est = m.get("estimates", {})
        estimated = []
        # Overrides replace a research value that is right but in a different convention
        # (a ring-and-pinion ratio where the overall final drive is needed); each has a reason.
        ov = m.get("overrides", {})
        corrected = [k for k in ov if not k.startswith("_")]

        def pick(field, research_val):
            if research_val not in (None, "", [], {}):
                return research_val
            if field in est:
                estimated.append(field)
                return est[field]
            raise SystemExit(f"{m['id']}: no research value and no estimate for {field}")

        cat = m["category"]
        p = {"id": m["id"], "category": cat, "label": m["label"], "real": True, "layout": m["layout"]}
        p["displacement"] = round(pick("displacement", e.get("displacementL")), 3)
        p["redline"] = int(pick("redline", first(e.get("redlineRpm"), e.get("maxRpm"))))
        p["idleRpm"] = int(pick("idleRpm", e.get("idleRpm")))
        fo = m.get("firingOrder", "research")
        if fo == "research":
            order = e.get("firingOrder") or []
            if order:
                p["firingOrder"] = order
                banks = m.get("banks") or {}
                if banks:
                    p["banks"] = banks
        elif isinstance(fo, list):
            p["firingOrder"] = fo
            if m.get("banks"):
                p["banks"] = m["banks"]
            estimated.append("firing order")
        p.update(m["model"])
        p["torque"] = torque_spec(e, est, p, estimated)
        if p.get("aspiration", "na") != "na":
            p["boost"] = pick("boost", (e.get("aspiration") or {}).get("peakBoostBar"))

        # Drivetrain: the vehicle this preset drives (or none).
        if m.get("vehicle") == "none":
            p["vehicle"] = "none"
        else:
            vid = "real-" + m["id"]
            gears = int(pick("gears", t.get("gears")))
            ratios = t.get("ratios") or []
            fd = first(ov.get("finalDrive"), t.get("finalDrive"), est.get("finalDrive"))
            if "finalDrive" not in ov and t.get("finalDrive") in (None, "") and "finalDrive" in est:
                estimated.append("final drive")
            if t.get("primaryDrive"):
                fd = round(t["primaryDrive"] * (t.get("finalDrive") or 1), 3)
            if m.get("ratiosAreOverall") and ratios:
                # Published as overall ratios (primary x gearbox x final): back out the gearbox.
                ratios = [round(x / fd, 4) for x in ratios]
            radius = first(tyre_radius(v.get("rearTyre")), est.get("wheelRadiusM"))
            if tyre_radius(v.get("rearTyre")) is None:
                estimated.append("wheel radius")
            if not radius:
                raise SystemExit(f"{m['id']}: no wheel radius (tyre '{v.get('rearTyre')}' did not parse and no estimate)")
            if not ratios or len(ratios) != gears:
                # Unpublished (race boxes are secret and track-dependent): spread the gears
                # so the top one reaches the car's known top speed at the rev limit.
                vtop = est["topSpeedKmh"] / 3.6
                top = p["redline"] * 2 * math.pi / 60 * radius / vtop
                overall = geometric_ratios(gears, top, est.get("ratioSpread", 2.6))
                fd = fd or 1.0
                ratios = [round(x / fd, 3) for x in overall]
                estimated.append(f"gear ratios (spread to {est['topSpeedKmh']} km/h at the rev limit)")
            mass = first(v.get("curbMassKg"), v.get("massKg"))
            if mass is None:
                mass = est["massKg"]; estimated.append("mass")
            mass += est.get("addKg", ADD_DRIVER_KG[cat])
            cd, area = v.get("cd"), v.get("frontalAreaM2")
            cda = round(cd * area, 3) if cd and area else est.get("cdA", DEFAULT_CDA[cat])
            vehicles[vid] = {
                "label": m["label"], "group": "Real vehicles", "real": True,
                "vehicle": {"massKg": round(mass), "wheelRadiusM": radius, "cdA": cda,
                            "crr": est.get("crr", DEFAULT_CRR[cat]), "brakeDecel": est.get("brakeDecel", DEFAULT_BRAKE[cat])},
                "gearboxRatios": ratios, "finalDrive": fd, "gearbox": m["gearbox"],
            }
            p["vehicle"] = vid
        if m.get("propeller"):
            p["propeller"] = m["propeller"]

        # The sentence the page shows, and the sources.
        words = {"idleRpm": "idle speed", "redline": "rev limit", "boost": "boost", "gears": "gear count",
                 "displacement": "displacement", "mass": "mass", "final drive": "final drive", "wheel radius": "wheel size"}
        estimated = [words.get(x, x) for x in estimated]
        p["spec"] = m["spec"] + (f" Estimated: {', '.join(dict.fromkeys(estimated))}." if estimated else "") + \
            (f" Corrected from the research: {'; '.join(ov['_why'][k] for k in corrected)}." if corrected else "")
        p["sources"] = (r or {}).get("sources", []) + m.get("extraSources", [])
        p["estimated"] = list(dict.fromkeys(estimated))
        presets.append(p)
    return presets, vehicles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    path = os.path.join(ROOT, "engine-data.json")
    data = json.load(open(path))
    model = json.load(open(os.path.join(RESEARCH, "preset-modelling.json")))
    presets, vehicles = build(model, load_research())

    new = dict(data)
    new["presets"] = [p for p in data["presets"] if not p.get("real")] + presets
    veh = {k: v for k, v in data["drivetrain"]["vehicles"].items() if not v.get("real")}
    veh.update(vehicles)
    new["drivetrain"] = {**data["drivetrain"], "vehicles": veh}
    if a.check:
        stale = new != data
        print("engine-data.json is", "STALE: run build-real-presets.py" if stale else "up to date")
        return 1 if stale else 0
    with open(path, "w") as fh:
        json.dump(new, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {len(presets)} real presets and {len(vehicles)} vehicles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
