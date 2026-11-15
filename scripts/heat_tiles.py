"""
15_make_heat_tiles.py  -  colour the south pole by HEIGHT and cut the picture into zoomable tiles.

What it does, in plain words
  1. Reads the 40 m LOLA height map of the south pole (the one you already have).
  2. Colours every pixel by its height: blue/purple = low (crater floors), green/yellow = middle, orange/red = high (mountains).
  3. Adds a little light and shadow ("hillshade") so crater walls and ridges are easy to see.
  4. Cuts the result into a pyramid of 512 x 512 pixel tiles:
        level 0 = 1 tile for the whole area (blurry), level 1 = 2 x 2 tiles, level 2 = 4 x 4 ... up to a level where one
        pixel is about 40 m (the sharpest the data allows). The web app loads only the tiles it needs for the current zoom.

Usage (from c:\\NASA\\polar-sky):   python scripts\\15_make_heat_tiles.py            colours  -> public\\pole_tiles
                                   python scripts\\15_make_heat_tiles.py --gray     Moon-like grey: dark = low, light = high -> public\\pole_tiles_gray
Output:  public\\pole_tiles\\<level>\\<x>\\<y>.webp   and   public\\pole_tiles\\manifest.json
Needs:   numpy, rasterio, pillow     (pip install numpy rasterio pillow)
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GRAY = "--gray" in sys.argv                                   # Moon-like grey heights instead of colours
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
DEM = Path(ARGS[0]) if len(ARGS) > 0 else ROOT / "data" / "LDEM_80S_40MPP_ADJ.tiff"
OUT = Path(ARGS[1]) if len(ARGS) > 1 else ROOT / "public" / ("pole_tiles_gray" if GRAY else "pole_tiles")

R_MOON = 1_737_400.0
TILE = 512                        # pixels per tile side
EXT = "webp"                      # webp is small; use "jpg" if your pillow has no webp
QUALITY = 85
HSEG = 32                         # each tile also gets a 33 x 33 grid of heights, so the app can raise the ground in 3D
# colour ramp: (position 0..1, R, G, B)
RAMP = [(0.00, 45, 25, 130), (0.18, 30, 90, 205), (0.38, 40, 185, 175), (0.55, 125, 205, 70),
        (0.72, 245, 225, 60), (0.87, 240, 125, 40), (1.00, 205, 35, 35)]
if GRAY:
    RAMP = [(0.00, 95, 95, 97), (1.00, 200, 200, 198)]        # lowest ground = dark grey, highest = light grey (Moon-like)
SUN_AZ, SUN_ALT = math.radians(315.0), math.radians(30.0)     # light used for the shading
DISC_R = 2 * R_MOON * math.tan(math.radians(5.0))             # the area down from 80 S is a disc of this radius (metres)


def colourise(h, lo, hi):
    t = np.clip((h - lo) / (hi - lo), 0, 1)
    pos = np.array([r[0] for r in RAMP])
    return np.stack([np.interp(t, pos, [r[c + 1] for r in RAMP]) for c in range(3)], axis=-1)


def shade(h, px_m):
    """Light and shadow from the heights. px_m = metres per pixel."""
    gy, gx = np.gradient(h.astype(np.float64), px_m)          # rows grow toward -y, so up in the picture is -gy
    nx, ny, nz = -gx, gy, np.ones_like(gx)
    lam = (nx * math.cos(SUN_ALT) * math.sin(SUN_AZ) + ny * math.cos(SUN_ALT) * math.cos(SUN_AZ) + nz * math.sin(SUN_ALT)) \
        / np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    s = np.clip(0.55 + 0.9 * (lam - math.sin(SUN_ALT)), 0.25, 1.15)
    if GRAY:
        s = np.clip(1.0 + 1.1 * (s - 0.55), 0.35, 1.25)       # light and shadow like a real Moon photo
    return s[..., None]


t0 = time.time()
with rasterio.open(DEM) as ds:
    pix = float(ds.res[0])
    n_cols, n_rows = ds.width, ds.height
    half = n_cols * pix / 2.0                                  # half width of the map in metres (304,000 for the real file)
    print(f"{DEM.name}: {n_cols} x {n_rows} pixels, {pix:g} m/pixel, {2 * half / 1000:.0f} km wide")
    max_level = max(0, math.ceil(math.log2(2 * half / (TILE * pix))))
    print(f"levels 0..{max_level}  (finest tile pixel = {2 * half / (TILE * 2 ** max_level):.1f} m)")

    # colour range from a small overview of the whole map (ignore the 0.5 % most extreme pixels)
    ov = ds.read(1, out_shape=(min(1024, n_rows), min(1024, n_cols)), resampling=Resampling.average).astype(np.float64)
    lo, hi = np.percentile(ov[np.isfinite(ov)], [0.5, 99.5])
    h_min, h_max = float(np.nanmin(ov)), float(np.nanmax(ov))
    print(f"colour range: {lo:.0f} m ({'dark grey' if GRAY else 'blue'}) to {hi:.0f} m ({'light grey' if GRAY else 'red'})")

    total = 0
    for z in range(max_level + 1):
        n = 2 ** z
        size = 2 * half / n                                    # tile width in metres at this level
        px_m = size / TILE                                     # metres per tile pixel
        # read window in DEM pixels, with 1 extra output pixel around so the shading matches across tile borders
        win_px = (TILE + 2) * px_m / pix
        scale = px_m / pix
        method = Resampling.average if scale > 1.5 else Resampling.bilinear
        made = 0
        for ty in range(n):
            y1 = half - ty * size
            for tx in range(n):
                x0 = -half + tx * size
                # skip tiles that lie completely outside the 80 S disc
                dx = x0 if x0 > 0 else (-(x0 + size) if x0 + size < 0 else 0.0)
                dy = (y1 - size) if (y1 - size) > 0 else (-y1 if y1 < 0 else 0.0)
                if math.hypot(dx, dy) > DISC_R:
                    continue
                col0 = (x0 + half) / pix - px_m / pix
                row0 = (half - y1) / pix - px_m / pix
                h = ds.read(1, window=Window(col0, row0, win_px, win_px), out_shape=(TILE + 2, TILE + 2),
                            resampling=method, boundless=True, fill_value=np.nan).astype(np.float64)
                if np.isnan(h).any():
                    h = np.where(np.isnan(h), np.nanmean(h) if np.isfinite(h).any() else lo, h)
                rgb = colourise(h, lo, hi) * shade(h, px_m)
                img = np.clip(rgb[1:-1, 1:-1], 0, 255).astype(np.uint8)
                d = OUT / str(z) / str(tx)
                d.mkdir(parents=True, exist_ok=True)
                if EXT == "webp":
                    Image.fromarray(img).save(d / f"{ty}.webp", "WEBP", quality=QUALITY, method=4)
                else:
                    Image.fromarray(img).save(d / f"{ty}.jpg", quality=QUALITY)
                # heights at the tile corners grid (int16 metres). h has 1 extra pixel all round, and pixel centres sit at +0.5,
                # so tile position t (in pixels) is array position t + 0.5: we blend the 4 pixels around it.
                q = np.arange(HSEG + 1) * (TILE / HSEG) + 0.5
                i0 = np.floor(q).astype(int); f = q - i0
                rows_ = h[i0, :] * (1 - f)[:, None] + h[i0 + 1, :] * f[:, None]
                grid = rows_[:, i0] * (1 - f)[None, :] + rows_[:, i0 + 1] * f[None, :]
                np.clip(np.round(grid), -32000, 32000).astype('<i2').tofile(d / f"{ty}.bin")
                made += 1
        total += made
        print(f"level {z}: {made} tiles   ({time.time() - t0:.0f}s)")

css = "linear-gradient(to right, " + ", ".join(f"rgb({r},{g},{b}) {p * 100:.0f}%" for p, r, g, b in RAMP) + ")"
(OUT / "manifest.json").write_text(json.dumps({
    "half_width_m": half, "tile_px": TILE, "max_level": max_level, "ext": EXT, "disc_radius_m": DISC_R,
    "moon_radius_m": R_MOON, "lo_m": float(lo), "hi_m": float(hi), "css": css,
    "relief_seg": HSEG, "h_min_m": h_min, "h_max_m": h_max,
}, indent=1))
size_mb = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
print(f"done: {total} tiles, {size_mb:.0f} MB, {time.time() - t0:.0f}s -> {OUT}")