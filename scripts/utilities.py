from pathlib import Path
import numpy as np

R = 1737400.0                     # m, LOLA reference sphere
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

def dem_path(mpp=40):
    for ext in ("tif", "tiff", "TIF", "TIFF"):
        p = DATA / f"LDEM_80S_{mpp}MPP_ADJ.{ext}"
        if p.exists():
            return p
    raise FileNotFoundError(f"LDEM_80S_{mpp}MPP_ADJ.tif(f) not found in {DATA}")

# ll_to_xy(lat, lon)
# c = deg(90) + lat 
# p = 2R · tan(c / 2) 
# x = p · sin(lon) 
# y = p · cos(lon)
# stereographic projection 
# from 3D to 2D to calculate distances in meter


#Because we're using a projection centered on the South Pole.


# - South Pole = latitude -90°
# - Equator = latitude 0°
# - North Pole = latitude +90°

# (R) = Moon's radius (approximately 1,737,400 meters).
# (c) = angular distance from the South Pole.
# (rho) = projected distance from the projection center.


# x =rho*sin(lon)
# y = rho*cos(lon)

# longitude and latitude 
# 3d -> 2d 
def ll_to_xy(lat_deg, lon_deg_east):# two angles -- describe on the moon's surface
    c = np.radians(90.0 + np.asarray(lat_deg, dtype=float))   # calculate the angle from the south pole in radian
    rho = 2.0 * R * np.tan(c / 2.0) # projected distance from the projection center
    lo = np.radians(lon_deg_east) # calculate the angle from the south pole in radian
    return rho * np.sin(lo), rho * np.cos(lo) # calculate X and Y 

# xy_to_ll (x,y)
# rho = sqrt(x^2+y^2)
# p = 2R * tan(c/2)
# c = 2*arctan(p/(2*R))
# lat = deg(c)-90 , lon = deg(arctan(x/y)) % 360  

def xy_to_ll(x, y):
    rho = np.hypot(x, y)
    c = 2.0 * np.arctan(rho / (2.0 * R))
    return np.degrees(c) - 90.0, np.degrees(np.arctan2(x, y)) % 360.0

def load_kernels():
    import glob, spiceypy as sp
    K = ROOT / "kernels"
    for pat in ["naif0012.tls", "pck00011.tpc", "de440s.bsp",
                "moon_de440*.tf", "moon_pa_de440*.bpc"]:
        found = sorted(glob.glob(str(K / pat)))
        if not found:
            raise FileNotFoundError(f"kernel '{pat}' not found in {K}")
        for f in found:
            sp.furnsh(f)