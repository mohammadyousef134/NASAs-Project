# Polar Sky Planner
 
**Compare Moon south pole landing sites and dates in seconds.**
See where the Sun and Earth sit above the real terrain horizon, how long the light and the Earth link will last, and which site is best for a 14-day stay.
 
Built by **Team Aurora** for the NASA Space Apps Challenge 2026.
 
**Live demo:** https://lunar-south-pole-visualizer.pages.dev
 
<!-- Add a screenshot or GIF here: ![Polar Sky Planner](docs/screenshot.png) -->
 
---
 
## The problem
 
Missions to the Moon's south pole face extreme lighting and communication limits. The Sun never climbs more than a few degrees above the horizon, terrain casts long shadows, and the Earth can slip below a ridge for days. Small changes in landing site or date can decide whether a lander has power and a link to Earth.
 
Existing tools such as NASA Quickmap, Moon Trek and JPL Horizons are built for specialists. Comparing several site and date combinations means switching between interfaces and reading raw data. Polar Sky Planner closes that gap with one interactive view.
 
## What it does
 
**Explore the pole in 3D**
- Real LOLA terrain of the south pole (80°S to the pole, 40 m per pixel), drawn as zoomable tiles.
- Three ground styles: true texture, height heatmap, and grey height map.
- Three views: Moon close-up, Earth and Moon at true scale, and Sun, Earth and Moon at true scale.
- Orbit camera around the Moon, Earth or Sun, or fly freely with the keyboard.
**Evaluate a landing site**
- Eight south pole sites chosen from the Artemis III candidate regions: Peak near Shackleton, Connecting Ridge, de Gerlache Rim, Haworth, Faustini Rim A, Malapert Massif, Nobile Rim and Amundsen Rim.
- Site card with *Sunlight now* and *Earth link now*, time until the Sun or Earth sets, and available power in W/m² on a vertical panel.
- Sunlight and Earth visibility over the next 14 days.
- Sky view from the site at true angular scale, with the terrain skyline, so you can see the Sun skimming the horizon.
**Move through time**
- Hourly data from 2027-01-01 to 2028-12-31.
- Play, step by day, pick any date from the calendar, or drag the slider. Playback runs from 1 hour per second up to 3 months per second.
**Rank the sites for any landing date**
- Pick a landing date and the app ranks all eight sites for the following 14 days, with a verdict (good, fair, poor or no-go), warnings and a short written report.
- The scoring rules are shown in the app under *How is the score calculated?*
## How it works
 
All heavy calculation happens offline in Python. The browser only reads the results, so the app is fast and needs no server.
 
```
LOLA 40 m DEM ──► find_sites ──► sites.json ──► horizons ──► horizons.json ─┐
                                                                             ├─► ranking_sites ──► ranking.json
NAIF SPICE kernels ──► export_ephemeris ──► ephemeris.bin ───────────────────┘
LOLA 40 m DEM ──► heat_tiles ──► pole_tiles / pole_tiles_gray
```
 
### Sun and Earth positions
`export_ephemeris.py` uses NASA SPICE (SpiceyPy) with the DE440s ephemeris. For every hour it stores the Sun and Earth directions and distances as seen from the Moon (light-time and stellar aberration corrected) plus the Moon's orientation matrix. The orientation comes from the high-accuracy lunar principal axes frame, so the Moon's libration is included.
 
### Terrain horizon
`horizons.py` computes the skyline at each site from the LOLA DEM. It casts a ray every 0.5° of azimuth out to 120 km and records the highest terrain angle. The lunar curvature is taken into account. Skylines are computed for antenna heights of 0, 2, 5 and 10 m; the app currently uses the 0 m skyline.
 
### Sun and Earth visibility
An object is visible when it is above the skyline at its azimuth. The Moon has no atmosphere, so there is no refraction.
- **Sun:** the apparent disc (radius about 0.267°) is treated as a disc, so sunrise and sunset are partial rather than instant. Sunlight is multiplied by the share of the disc left uncovered when the Earth passes in front of it (an eclipse seen from the Moon).
- **Earth:** counted as visible when its above the horizon.
The same math runs in Python (`ranking_sites.py`) and in the browser (`evalSite()` in `main.js`).
 
### Ranking rules
For each landing date and site, the app looks at the next 14 days (336 hours).
 
| Rule | Points |
|---|---|
| Power: share of hours with the Sun above the terrain | up to 50 |
| Earth link: share of hours with the Earth above the terrain | up to 30 |
| Continuity: penalty for the longest period of darkness | up to 20 |
 
- **No-go:** Earth in view less than 25% of the time, or Sun less than 25%.
- **Verdict:** 70 or more is good, 40 or more is fair, below 40 is poor.
- **Warnings:** darkness or no Earth link lasting more than 48 hours.
- Ties are broken by more sunlight.
All thresholds are assumptions and can be changed at the top of `scripts/ranking_sites.py`.
 
## Run it locally
 
The app is a static site with no build step. Serve the `public` folder with any web server (browsers block ES modules over `file://`).
 
```bash
cd public
python -m http.server 8000
```
 
Then open http://localhost:8000.
 
Controls in the free-fly camera: drag to look, `W` `A` `S` `D` to move, `R` `F` for up and down, `Q` `E` to roll, mouse wheel to move forward and back, `Shift` to slow down. Press `H` to hide the panels.
 
## Rebuild the data 
 
The repository already contains all generated data in `public/`. You only need this section to regenerate it.
 
**Requirements:** Python 3.10 or newer and `numpy`, `scipy`, `rasterio`, `spiceypy`, `Pillow`.
 
```bash
pip install numpy scipy rasterio spiceypy Pillow
```
 
**Input data:** download `LDEM_80S_40MPP_ADJ.tif` from the NASA LOLA polar data (PDS Geosciences Node) and place it in `data/`. It is not stored in the repository because of its size. The SPICE kernels are already in `kernels/`.
 
Run the scripts from the repository root, in this order:
 
```bash
python scripts/find_sites.py          # snap the named sites to the DEM, writes data/sites.json
cp data/sites.json public/sites.json  # the app and later steps read this copy
python scripts/export_ephemeris.py    # hourly Sun, Earth and Moon orientation -> public/ephemeris.bin
python scripts/horizons.py            # terrain skyline per site -> public/horizons.json
python scripts/ranking_sites.py       # score every site for every landing date -> public/ranking.json
python scripts/heat_tiles.py          # colour tiles -> public/pole_tiles
python scripts/heat_tiles.py --gray   # grey tiles   -> public/pole_tiles_gray
```
 
`scripts/visibility.py` is an optional cross-check at 10-minute resolution and writes `public/visibility.json`.
 
If you change the stay length, update `WINDOW_H` in both `scripts/ranking_sites.py` and `public/main.js`.
 
## Project structure
 
```
public/            the website (deployed as is)
  index.html       layout and styles
  main.js          3D scene, time controls, site card, sky view
  ranking.js       site ranking panel
  poletiles.js     zoomable terrain tiles
  ephemeris.bin    hourly Sun/Earth/Moon data, 2027-2028
  horizons.json    terrain skylines per site
  ranking.json     precomputed ranking for every landing date
  sites.json       the eight sites
  pole_tiles*/     terrain tiles (colour and grey)
scripts/           Python data pipeline
kernels/           NAIF SPICE kernels
data/              site definitions and the Artemis III candidate regions
```
 
## Limitations

- Not all locations at the lunar south pole are clickable or rankable; only the candidate sites are.
- The power figure counts hours of sunlight and battery size of the spacecraft.
- Ranking weights and thresholds are planning assumptions, not mission requirements.
## Data and credits
 
- **Terrain:** *A New View of the Lunar South Pole from LOLA*, NASA Planetary Geodesy Data Archive (PGDA), LRO Lunar Orbiter Laser Altimeter (LOLA) south pole digital elevation model `LDEM_80S_40MPP_ADJ`. [pgda.gsfc.nasa.gov/products/90](https://pgda.gsfc.nasa.gov/products/90)
- **Ephemeris and orientation:** NASA NAIF SPICE kernels, used through [SpiceyPy](https://github.com/AndrewAnnex/SpiceyPy). All kernels come from the NAIF generic kernels folder, `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`.
  | Kernel | Purpose | Download |
  |---|---|---|
  | `naif0012.tls` | Leap seconds | [link](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls) |
  | `pck00011.tpc` | Planet constants | [link](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc) |
  | `de440s.bsp` | Planet positions | [link](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp) |
  | `moon_pa_de440_200625.bpc` | Moon orientation | [link](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc) |
  | `moon_de440_250416.tf` | Moon reference frame | [link](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf) |
- **Candidate regions:** NASA Artemis III candidate landing regions (`data/A3_Named_regions.geojson`).
- **3D rendering:** [Three.js](https://threejs.org/) r186.

 
