#!/usr/bin/env python3
"""Turn the PNG renders from scripts/render-engine-thumbs.mjs into img/presets/<id>.webp
(480x300, 16:10) and delete the PNGs."""
import os
from PIL import Image

D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "img", "presets")
for f in sorted(os.listdir(D)):
    if f.endswith(".png"):
        im = Image.open(os.path.join(D, f)).convert("RGB").resize((480, 300), Image.LANCZOS)
        im.save(os.path.join(D, f[:-4] + ".webp"), "WEBP", quality=82, method=6)
        os.remove(os.path.join(D, f))
        print(f[:-4])
