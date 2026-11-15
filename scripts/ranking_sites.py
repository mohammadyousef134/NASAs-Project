#!/usr/bin/env python3
"""
18_rank_sites.py  -  precompute the ranking of the landing sites for every landing date.

For every landing date (00:00 UTC) and every site, we look at the next 6.5 days (156 hours) and score the site
with three simple rules (see RULES below). The result is public/ranking.json, which the website just reads.

How it works (the algorithm):
  1. Read the precomputed sky: ephemeris.bin has, for every hour, the Sun direction, the Earth direction and the
     Moon's rotation matrix.
  2. For every site and every hour, work out where the Sun and the Earth are in the SITE'S sky (azimuth, elevation)
     and compare them with the site's skyline (horizons.json). This gives, per hour:
        sun fraction  : how much of the Sun's disc is above the terrain (0 to 1)
        earth in view : is the Earth above the terrain (yes or no)
     This is exactly what the website does for one site; here we do it once for all hours, with numpy.
  3. For every landing date, take the 156 hours that follow it and compute four numbers per site:
        S     = share of hours with the Sun above the terrain (0 to 1)   how much power
        E     = share of hours with the Earth in view     (0 to 1)   how much communication
        dark  = longest run of hours with no Sun          (hours)    how long the lander must survive without power
        gap   = longest run of hours with no Earth        (hours)    how long without a link
  4. Apply the knock-out rules, score with the rest, and rank the sites.

Run from the project folder:   python scripts/18_rank_sites.py            (reads and writes public/)
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------- the rules (change the numbers here)
WINDOW_H = 336                 # 14 days (24 x 14), the stay length we chose. Must match WINDOW_H in main.js
W_POWER, W_EARTH, W_CONT = 50, 30, 20     # points: power, Earth link, no long darkness  (total 100)
DARK_LIMIT_H = 48              # warning if the lander would sit in darkness longer than this (assumption)
GAP_LIMIT_H = 48               # warning if there is no Earth link for longer than this (assumption)
GOOD, FAIR = 70, 40            # verdict: score >= 70 good, >= 40 fair, below that poor
MIN_EARTH_PCT = 25             # knock-out: Earth in view less than this share of the time -> NO-GO (no link, no mission)
MIN_SUN_PCT = 25               # knock-out: Sun above the terrain less than this share of the time -> NO-GO (no power)
SUN_R_DEG = 0.267              # apparent radius of the Sun's disc seen from the Moon (same value as the website)
RM_KM, EARTH_KM, SUN_KM = 1737.4, 6371.0, 695700.0   # Moon radius, Earth radius, Sun radius (km)
STRIDE = 17                    # floats per hour in ephemeris.bin: sun[3] earth[3] rotation[9] sun_km earth_km

RULES = [
    f"Power: up to {W_POWER} points = {W_POWER} x the share of hours with the Sun above the terrain.",
    f"Earth link: up to {W_EARTH} points = {W_EARTH} x the share of hours with the Earth above the terrain.",
    f"Continuity: up to {W_CONT} points = {W_CONT} x (1 - longest darkness / stay). A long blackout costs points.",
    f"Knock-out: Earth in view under {MIN_EARTH_PCT} % of the time, or Sun under {MIN_SUN_PCT} %, makes the site NO-GO. It ranks below every valid site.",
    f"Verdict: {GOOD}+ good, {FAIR}+ fair, below {FAIR} poor. Warning if darkness or no Earth link lasts over {DARK_LIMIT_H} h.",
    "The Earth in front of the Sun (a lunar eclipse seen from the Moon) counts as lost sunlight.",
    "Ties are broken by more sunlight.",
]


# ---------------------------------------------------------------- reading the inputs (same rules as the website)
def norm(x):
    return re.sub(r"[^a-z0-9]", "", str(x if x is not None else "").lower())


def first_numeric_array(o, depth=0):
    """Same search as the website: the first list of >= 36 numbers, preferring keys that look like a bare horizon."""
    if isinstance(o, list) and len(o) >= 36 and all(v is None or isinstance(v, (int, float)) for v in o):
        return o
    if isinstance(o, dict) and depth < 3:
        pref = re.compile(r"horizon|elev|^el$|mast.?0|^0$|0m", re.I)
        keys = sorted(o.keys(), key=lambda k: 0 if pref.search(k) else 1)       # stable: matching keys first
        for k in keys:
            r = first_numeric_array(o[k], depth + 1)
            if r is not None:
                return r
    return None


def load_sites(public):
    raw = json.load(open(public / "sites.json"))
    arr = raw if isinstance(raw, list) else raw.get("sites", list(raw.values()))
    sites = [s for s in arr if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float))]
    hz = json.load(open(public / "horizons.json"))
    root = hz if isinstance(hz, list) else hz.get("sites", hz)
    entries = [(e.get("id") or e.get("name") or e.get("site"), e) for e in root] if isinstance(root, list) else list(root.items())
    out = []
    for s in sites:
        sid, name = str(s.get("id", s.get("name", "site"))), s.get("name", s.get("id", "site"))
        e = next((e for k, e in entries if norm(k) == norm(sid) or norm(k) == norm(name)
                  or (isinstance(e, dict) and (norm(e.get("id")) == norm(sid) or norm(e.get("name")) == norm(name)))), None)
        arr_h = first_numeric_array(e) if e is not None else None
        if arr_h is None:
            sys.exit(f"No horizon found in horizons.json for site '{sid}'.")
        out.append({"id": sid, "name": name, "lat": float(s["lat"]), "lon": float(s["lon"]),
                    "horizon": np.array([0.0 if v is None else v for v in arr_h], dtype=np.float64)})
    return out


def load_ephemeris(public):
    meta = json.load(open(public / "ephemeris.json"))
    n = int(meta["n"])
    f = np.fromfile(public / "ephemeris.bin", dtype="<f4").astype(np.float64)
    if f.size != n * STRIDE:
        sys.exit(f"ephemeris.bin has {f.size} numbers, expected {n * STRIDE}. Is ephemeris.json from the same run?")
    return meta, f.reshape(n, STRIDE)


# ---------------------------------------------------------------- Earth in front of the Sun (eclipse seen from the Moon)
def disc_overlap(r1, r2, d):
    """Share of disc 1 (the Sun, radius r1) covered by disc 2 (the Earth, radius r2); d = distance of the centres. Radians, numpy arrays.
    Same formula as discOverlap() in main.js."""
    r1, r2, d = np.broadcast_arrays(np.asarray(r1, float), np.asarray(r2, float), np.asarray(d, float))
    out = np.zeros(d.shape)
    inside = d <= np.abs(r1 - r2)
    out[inside] = np.where(r2[inside] >= r1[inside], 1.0, (r2[inside] / r1[inside]) ** 2)
    part = (d < r1 + r2) & ~inside
    r1p, r2p, dp = r1[part], r2[part], d[part]
    a = r1p ** 2 * np.arccos(np.clip((dp ** 2 + r1p ** 2 - r2p ** 2) / (2 * dp * r1p), -1, 1))
    b = r2p ** 2 * np.arccos(np.clip((dp ** 2 + r2p ** 2 - r1p ** 2) / (2 * dp * r2p), -1, 1))
    c = 0.5 * np.sqrt(np.maximum((-dp + r1p + r2p) * (dp + r1p - r2p) * (dp - r1p + r2p) * (dp + r1p + r2p), 0))
    out[part] = (a + b - c) / (np.pi * r1p ** 2)
    return out


# ---------------------------------------------------------------- step 2: the sky of one site, hour by hour
def hourly_state(site, eph):
    """Returns (sun_fraction[N], earth_in_view[N]) for every hour, the same maths as evalSite() in main.js."""
    unit = lambda v: v / np.linalg.norm(v, axis=1, keepdims=True)
    sun_j, earth_j = unit(eph[:, 0:3]), unit(eph[:, 3:6])               # directions in the sky frame (J2000)
    R = eph[:, 6:15].reshape(-1, 3, 3)                                  # Moon-fixed -> sky rotation, row-major
    sun_m = np.einsum("nji,nj->ni", R, sun_j)                           # R^T v : back into the Moon-fixed frame
    earth_m = np.einsum("nji,nj->ni", R, earth_j)

    la, lo = np.radians(site["lat"]), np.radians(site["lon"])
    u = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])      # up at the site
    z = np.array([0.0, 0.0, 1.0])
    n_ = z - (z @ u) * u
    n_ /= np.linalg.norm(n_)                                                           # north
    e_ = np.cross(n_, u)                                                               # east

    def az_el(d):
        el = np.degrees(np.arcsin(np.clip(d @ u, -1, 1)))
        az = (np.degrees(np.arctan2(d @ e_, d @ n_)) + 360.0) % 360.0
        return az, el

    def skyline(az):
        h = site["horizon"]
        k = len(h)
        x = (az % 360.0) / 360.0 * k
        i = np.floor(x).astype(int) % k
        a = x - np.floor(x)
        return h[i] * (1 - a) + h[(i + 1) % k] * a

    s_az, s_el = az_el(sun_m)
    e_az, e_el = az_el(earth_m)
    sun_frac = np.clip((s_el + SUN_R_DEG - skyline(s_az)) / (2 * SUN_R_DEG), 0.0, 1.0)
    # Earth eclipse, seen from the site (not from the Moon's centre)
    S = eph[:, 15, None] * sun_m - RM_KM * u
    E = eph[:, 16, None] * earth_m - RM_KM * u
    sl, el_ = np.linalg.norm(S, axis=1), np.linalg.norm(E, axis=1)
    sep = np.arccos(np.clip((S * E).sum(axis=1) / (sl * el_), -1, 1))
    sun_frac = sun_frac * (1.0 - disc_overlap(np.arcsin(SUN_KM / sl), np.arcsin(EARTH_KM / el_), sep))
    earth_up = e_el > skyline(e_az)
    return sun_frac, earth_up


# ---------------------------------------------------------------- step 3: one 6.5-day window
def longest_run(mask):
    best = run = 0
    for v in mask:
        run = run + 1 if v else 0
        best = max(best, run)
    return best


def window_numbers(sun_frac, earth_up, start):
    s = sun_frac[start:start + WINDOW_H]
    e = earth_up[start:start + WINDOW_H]
    return (s > 0).mean(), e.mean(), longest_run(s == 0), longest_run(~e)


# ---------------------------------------------------------------- step 4: the rules
def score(S, E, dark):
    return W_POWER * S + W_EARTH * E + W_CONT * (1 - dark / WINDOW_H)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--public", default="public", help="folder with ephemeris.bin/json, sites.json, horizons.json")
    ap.add_argument("--out", default=None, help="output file (default: <public>/ranking.json)")
    a = ap.parse_args()
    public = Path(a.public)

    meta, eph = load_ephemeris(public)
    n = eph.shape[0]
    sites = load_sites(public)
    n_days = (n - 1 - WINDOW_H) // 24 + 1                              # landing dates whose whole stay fits in the data
    print(f"{len(sites)} sites, {n} hours, {n_days} landing dates, window {WINDOW_H} h")

    state = [hourly_state(s, eph) for s in sites]                      # per site: sun fraction and Earth-in-view per hour
    days = []
    best = []
    for d in range(n_days):
        row = []
        for sf, eu in state:
            S, E, dark, gap = window_numbers(sf, eu, 24 * d)
            row.append([round(score(S, E, dark), 1), round(100 * S, 1), round(100 * E, 1), int(dark), int(gap)])
        days.append(row)
        valid = lambda i: row[i][2] >= MIN_EARTH_PCT and row[i][1] >= MIN_SUN_PCT
        best.append(max(range(len(sites)), key=lambda i: (valid(i), row[i][0], row[i][1])))

    start_iso = meta["start"][:10]
    out = {
        "version": 1,
        "start": start_iso,
        "window_hours": WINDOW_H,
        "n_days": n_days,
        "sites": [{"id": s["id"], "name": s["name"]} for s in sites],
        "rule": {"weights": {"power": W_POWER, "earth": W_EARTH, "continuity": W_CONT},
                 "dark_limit_h": DARK_LIMIT_H, "gap_limit_h": GAP_LIMIT_H, "good": GOOD, "fair": FAIR,
                 "min_earth_pct": MIN_EARTH_PCT, "min_sun_pct": MIN_SUN_PCT, "text": RULES},
        "columns": ["score", "sun_pct", "earth_pct", "longest_dark_h", "longest_earth_gap_h"],
        "best": best,
        "days": days,
    }
    path = Path(a.out) if a.out else public / "ranking.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    wins = np.bincount(best, minlength=len(sites))
    print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB)")
    for s, w in zip(sites, wins):
        print(f"  {s['name']:<28} best site on {w:>3} of {n_days} dates")


if __name__ == "__main__":
    main()