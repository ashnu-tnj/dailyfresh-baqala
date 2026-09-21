#!/usr/bin/env python3
"""Draw the DailyFresh app icon.

Meta wants 1024x1024 and shows the icon as small as ~32px, so this is built from
a handful of bold shapes with high contrast and no text. Drawn at 4x and
downsampled for clean edges.

    python docs/brand/make-icon.py   ->  docs/brand/dailyfresh-icon-1024.png
"""
import os
from PIL import Image, ImageDraw

S = 4096                      # supersample canvas
OUT = 1024
HERE = os.path.dirname(os.path.abspath(__file__))

BG = (0x2E, 0x7D, 0x32)       # green 800
WHITE = (0xFF, 0xFF, 0xFF)
MINT = (0xC8, 0xE6, 0xC9)     # green 100


def quad(p0, p1, p2, n=80):
    """Points along a quadratic bezier."""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def main():
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)

    # Flat background. A gradient reads as mush at 32px and costs four times the
    # file size once the PNG is quantised.
    d.rectangle([0, 0, S, S], fill=BG)

    cx = S // 2

    # Leaf, standing above the basket.
    tip, base = (cx, 900), (cx, 2150)
    leaf = quad(tip, (cx + 760, 1420), base) + quad(base, (cx - 760, 1420), tip)
    d.polygon(leaf, fill=MINT)
    d.line([(cx, 1000), (cx, 2080)], fill=(0x2E, 0x7D, 0x32), width=42)

    # Produce peeking over the rim.
    for x, r in ((cx - 560, 300), (cx + 560, 300)):
        d.ellipse([x - r, 2180 - r, x + r, 2180 + r], fill=MINT)

    # Basket: trapezoid with a rounded bottom, plus a rim bar.
    rim_y, bot_y = 2320, 3260
    half_top, half_bot = 1180, 830
    body = [(cx - half_top, rim_y), (cx + half_top, rim_y),
            (cx + half_bot, bot_y), (cx - half_bot, bot_y)]
    d.polygon(body, fill=WHITE)
    d.ellipse([cx - half_bot, bot_y - 300, cx + half_bot, bot_y + 300], fill=WHITE)

    # Rim bar sits proud of the body so the basket reads at small sizes.
    d.rounded_rectangle([cx - 1290, rim_y - 190, cx + 1290, rim_y + 130],
                        radius=160, fill=WHITE)

    # Weave: three slots cut out of the basket body.
    for i, dy in enumerate((330, 640, 950)):
        hw = int(half_top - (half_top - half_bot) * (dy / (bot_y - rim_y)) * 1.15) - 190
        d.rounded_rectangle([cx - hw, rim_y + dy - 55, cx + hw, rim_y + dy + 55],
                            radius=55, fill=BG)

    img = img.resize((OUT, OUT), Image.LANCZOS)
    # Four flat colours quantise losslessly and keep the upload tiny.
    img = img.quantize(colors=16, method=Image.MEDIANCUT).convert("RGB")
    path = os.path.join(HERE, "dailyfresh-icon-1024.png")
    img.save(path, "PNG", optimize=True)
    print("wrote %s (%dx%d, %.0f KB)" % (path, OUT, OUT, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
