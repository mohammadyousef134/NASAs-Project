import json
import numpy as np, spiceypy as sp
# spiceypy is the standard library for the planet position and orientation 
from utilities import load_kernels, DATA, ROOT

STEP_MIN = 10 # for every 10 min where the sun and earth are 
START = "2027-01-01 00:00:00 UTC"
N_DAYS = 730
# 365 + 365 
MISSION_DAYS = 14
# estimated number 14 mission
R_MOON_KM, R_SUN_KM, R_EARTH_KM = 1737.4, 695700.0, 6378.1
EARTH_MARGIN_DEG = 0.0           # extra clearance required for comms

load_kernels()
# load all needed kernals 
et0 = sp.str2et(START)
# convert from human-readable to ephemeris time
n = int(N_DAYS * 24 * 60 / STEP_MIN)
# calculate from days to minutes and divided it by 10 minutes 
ets = et0 + np.arange(n) * STEP_MIN * 60.0 
# calculate the seconds once 

# Sun and Earth positions relative to the Moon centre in the Moon-fixed frame
sun = np.array([sp.spkpos("SUN",   et, "MOON_ME", "LT+S", "MOON")[0] for et in ets]) # 105120 position for each 10 min calculate the position of the sun relative to the moon
earth = np.array([sp.spkpos("EARTH", et, "MOON_ME", "LT+S", "MOON")[0] for et in ets]) # 105120 position for each 10 min calculate the position of the earth relative to the moon
# print("ephemeris done:", n, "steps")

horizons = json.load(open(ROOT / "public" / "horizons.json")) # load the horizon of each site computed and stored at horizon.json




# this is used to find the longest sun lit or connection with the earth could be more than 14 days but it's simple for the presentation purposes 
# [0,+1,0,-1,1,-1]
# [1,3][4,5]
# longest is [1,3] = 3-1 = 2 max non interrupted sit-connection
def run_len(mask):
    m = np.concatenate(([0], mask.astype(np.int8), [0]))
    dd = np.diff(m)
    st, en = np.where(dd == 1)[0], np.where(dd == -1)[0]
    return int((en - st).max()) if len(st) else 0



# the mission length divided by 10 minutes
W = int(MISSION_DAYS * 24 * 60 / STEP_MIN)
# 8*105120 table one byte per site per time step
flags = np.zeros((len(horizons), n), dtype=np.uint8)
# stats : stores the scores , ids : store the row order
stats, ids = {}, []
# k : row number in flags , sid : site ID , s
for k, (sid, s) in enumerate(horizons.items()):
    ids.append(sid)
    # vector for the sites positions in lon lat
    lat, lon = np.radians(s["lat"]), np.radians(s["lon"])
    # convert from the lat lon radius to X Y Z 
    pos = (R_MOON_KM + s["height_m"] / 1000.0) * np.array(
        [np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    # calculate the directions from the site not the moon's centre (local axes)
    up = pos / np.linalg.norm(pos)
    east = np.array([-np.sin(lon), np.cos(lon), 0.0])
    north = np.cross(up, east)
    hz = np.array(s["horizon"]["0"])
    # needs to compute the 0,2,5,10 also not just the 0
    grid = np.arange(0, 360, s["az_step"])

    # convert position to azimuths and elevations 
    def azel(vec):
        # the vector from the site to the sun or earth
        dv = vec - pos
        # distance to the body 
        r = np.linalg.norm(dv, axis=1)
        u = dv / r[:, None]
        return (np.degrees(np.arctan2(u @ east, u @ north)) % 360,
                np.degrees(np.arcsin(u @ up)), r)

    az_s, el_s, r_s = azel(sun)
    az_e, el_e, r_e = azel(earth)
    rad_s = np.degrees(np.arcsin(R_SUN_KM / r_s))
    h_s = np.interp(az_s, grid, hz, period=360)
    h_e = np.interp(az_e, grid, hz, period=360)

    sun_frac = np.clip((el_s + rad_s - h_s) / (2 * rad_s), 0, 1)   # visible share of the disk
    sun_vis = sun_frac > 0
    earth_vis = el_e > h_e + EARTH_MARGIN_DEG
    flags[k] = sun_vis.astype(np.uint8) | (earth_vis.astype(np.uint8) << 1)

    cs = np.concatenate(([0], np.cumsum(sun_vis)))
    ok = (cs[W:] - cs[:-W]) == W                                    # 14 days of continuous sun
    stats[sid] = dict(
        name=s["name"],
        power_pct=round(float(sun_frac.mean() * 100), 1),
        sun_visible_pct=round(float(sun_vis.mean() * 100), 1),
        connection_pct=round(float(earth_vis.mean() * 100), 1),
        both_pct=round(float((sun_vis & earth_vis).mean() * 100), 1),
        longest_dark_h=round(run_len(~sun_vis) * STEP_MIN / 60, 1),
        longest_blackout_h=round(run_len(~earth_vis) * STEP_MIN / 60, 1),
        pct_starts_with_6p5d_sun=round(float(ok.mean() * 100), 1),
    )
    t_ = stats[sid]
    print(f"{s['name']:22s} power {t_['power_pct']:5.1f}%  comms {t_['connection_pct']:5.1f}%  "
          f"dark {t_['longest_dark_h']:6.1f} h  blackout {t_['longest_blackout_h']:6.1f} h  "
          f"14d-sun starts {t_['pct_starts_with_6p5d_sun']:5.1f}%")


# save all the calculated visibilities here once 


flags.tofile(ROOT / "public" / "visibility.bin")
json.dump(dict(start=START, et0=et0, step_min=STEP_MIN, n=n, sites=ids,
               bits="bit0=sun visible, bit1=earth visible", stats=stats),
          open(ROOT / "public" / "visibility.json", "w"), indent=1)