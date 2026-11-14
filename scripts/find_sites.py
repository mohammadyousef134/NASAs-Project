import json
import numpy as np, rasterio
from rasterio.windows import Window
from utilities import dem_path, ll_to_xy, xy_to_ll, DATA

# id, name, approx lat, approx lon (deg E), snap radius (km)
# radius is about the crater radius, so the snap lands on the rim high point
# we use the DEM to coordinate the approxi

SITES = [
    ("shackleton",     "Peak near Shackleton", -89.9, 129.8, 10), # we have the R because the points are approximate 
    ("connecting",     "Connecting Ridge",     -89.45, 222.9, 6), # so when we search the best landing site we find the nearby terrain not all the DEM (Digital elevation model)
    ("de_gerlache",    "de Gerlache Rim",      -88.5, 272.9, 16),
    ("haworth",        "Haworth",              -87.5, 355.0, 17),
    ("faustini",       "Faustini Rim A",       -87.3,  77.0, 20),
    ("malapert",       "Malapert Massif",      -86.0,   0.0, 8),
    ("nobile",         "Nobile Rim",           -85.2,  53.3, 20),
    ("amundsen",       "Amundsen Rim",         -84.5,  82.8, 50),
]

# For a typical north-up raster:
# - t.a = pixel width
# - t.e = pixel height, usually negative
# - t.c = x-coordinate of the raster's left edge
# - t.f = y-coordinate of the raster's top edge
def snap(ds, x, y, radius_m):
    n = int(np.ceil(radius_m / ds.res[0])) # turn meters into pixels -- 10km / 40m (per pixel) = read 250 pixel each way 
    r0, c0 = ds.index(x, y) # get the pixel that has the coordinates x y (center point)
    ro, co = max(r0 - n, 0), max(c0 - n, 0) # top left corner not negative 
    h = min(2 * n + 1, ds.height - ro) # height in pixels
    w = min(2 * n + 1, ds.width - co) # width in pixels
    arr = ds.read(1, window=Window(co, ro, w, h)).astype("float32") # read the pixels inside the w h starting from top left corner
    rr, cc = np.mgrid[0:h, 0:w]  # convert each pixel into its real world X Y get each value from the extracted window
    t = ds.transform # get the raster transformation from pixel to map coordinates 
    xs = t.c + (cc + co + 0.5) * t.a          # pixel centres (pixel-registered grid) cc is in the window cc+co is in the whole DEM 
    # convert this pixel to real X axis 
    ys = t.f + (rr + ro + 0.5) * t.e
    # convert this pixel to real Y axis 
    # np.hypot(xs - x, ys - y)  = Euclidean distance formula     
    arr[np.hypot(xs - x, ys - y) > radius_m] = np.nan # make all the points not in the range of the circle NAN 
    i = np.nanargmax(arr) #get the max DEM (highest point inside the range)
    ri, ci = np.unravel_index(i, arr.shape) # get the highest point coordinates 
    center_h = float(ds.read(1, window=Window(c0, r0, 1, 1))[0, 0]) # 
    return float(xs[ri, ci]), float(ys[ri, ci]), float(arr[ri, ci]), center_h
            # X for the highest 
            # Y for the lowest 
            # elevation of the highest point
            # center elevation value

out = []
with rasterio.open(dem_path(40)) as ds:
    print(f"{'site':22s} {'lat':>8s} {'lon':>8s} {'height_m':>9s} {'moved_km':>9s} {'depth_m':>8s}")
    for sid, name, lat, lon, rad_km in SITES:
        x0, y0 = ll_to_xy(lat, lon)
        x, y, hgt, center_h = snap(ds, float(x0), float(y0), rad_km * 1000)
        la, lo = xy_to_ll(x, y)
        moved = np.hypot(x - x0, y - y0) / 1000
        depth = hgt - center_h     # rim height minus height at the approximate crater centre
        # print(f"{name:22s} {la:8.3f} {lo:8.2f} {hgt:9.0f} {moved:9.1f} {depth:8.0f}")
        out.append(dict(id=sid, name=name, lat=float(la), lon=float(lo),
                        x=x, y=y, height_m=hgt, snap_radius_km=rad_km))

json.dump(out, open(DATA / "sites.json", "w"), indent=2)