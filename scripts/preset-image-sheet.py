#!/usr/bin/env python3
"""Tile every picture in a folder (default img/presets) into one labelled sheet for review:
preset-image-sheet.py OUT.png [DIR]"""
import os, sys
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "img", "presets")
files = sorted(f for f in os.listdir(D) if f.endswith(".webp"))
cols, tw, th = 8, 240, 150
sheet = Image.new("RGB", (cols * (tw + 4) + 4, ((len(files) + cols - 1) // cols) * (th + 18) + 4), (24, 24, 28))
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    x, y = 4 + (i % cols) * (tw + 4), 4 + (i // cols) * (th + 18)
    sheet.paste(Image.open(os.path.join(D, f)).convert("RGB").resize((tw, th)), (x, y))
    dr.text((x, y + th + 3), f[:-5][:38], fill=(255, 200, 120))
sheet.save(sys.argv[1])
