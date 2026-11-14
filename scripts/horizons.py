import json
# to create the horizon for each site 
import numpy as np, rasterio
# to work with LDEM LDEM => Lunar digital elevation model
from rasterio.windows import Window
# Gets a rectangle of the DEM file to work only on the needed area
from scipy.ndimage import map_coordinates
# Reads each pixels elevation value 
from utilities import dem_path, ll_to_xy, R, DATA, ROOT
# dem_path -> to get the LDEM file --- some constants and helper functions R = 1737400

# Just calculate the horizontal line when you stand on a certain point 
# turn around each turn 5 degrees for 360 degree so you have 720 degree them see 120km distance what's the highest point and use it to create the horizon 
# from (azimuth , distance) to lon/lat to x/y -> pixels

MAX_KM = 120
# MAX length to go for it 
AZ_STEP = 0.5
# each 0.5 degree calculate it so -> 360*2 = 720 
MASTS = [0, 2, 5, 10]                 
# above the landing site with 0,2,5 and 10 meters because the antenna could reach that long and to see how tall the antenna needs to be so it is visible for the earth or sun

sites = json.load(open(DATA / "sites.json"))
# load pre-computed sites 


az_deg = np.arange(0, 360, AZ_STEP)

# create the array of degrees (0.5,1.0,1.5,2.0)

az = np.radians(az_deg)[:, None]
# turn it to the radian shape : (720,1)
# fine steps near the site, coarser far away

# the step in the nearby locations is in 40 meter step (1px) because the nearby terrain effects more that the far away terrain so it need to be more detailed 
# the step in the far away 200 meter (5px) because it needs to be very large to block something 
# 500 point for the nearby locations and 499 for the far away shape :(1,999)
d = np.concatenate([np.arange(40, 20000, 40), np.arange(20000, MAX_KM * 1000, 200)])[None, :]

# for each distance to radian ==>> distance / radius = radian
c = d / R 

# store the result
result = {}
# open the LDEM -> Lunar digital elevation model .tif
with rasterio.open(dem_path(40)) as ds:
    t = ds.transform
    # t.c and t.f are the X,Y for the top left corner 
    # t.a 40+ width t.e 40- height
    for s in sites:
        # 120km + 2km saftey
        half = MAX_KM * 1000 + 2000
        # find the left and right edges of the tile 
        # (s["x"] - half - t.c) / t.a -> from X/Y to Row/Column
        # s["x"] - half for the left |||| s["x"] + half for the right
        # max and min to be inside the DEM file 


        col0 = max(int((s["x"] - half - t.c) / t.a), 0)
        col1 = min(int((s["x"] + half - t.c) / t.a) + 1, ds.width)


        # Here swapped because the t.c is negative so when we divide the sign is turned (Largest Y means Smallest Row)
        row0 = max(int((s["y"] + half - t.f) / t.e), 0)
        row1 = min(int((s["y"] - half - t.f) / t.e) + 1, ds.height)

        # read the rectangle and store it in float so we do the circle work to hold the NaN
        # 244 km with 40m is 244000/40 = 6100*6100 pixel which is 150 so much less than the large DEM file 
        dem = ds.read(1, window=Window(col0, row0, col1 - col0, row1 - row0)).astype("float32")


        # get the lat lon for each point in radians
        la0, lo0 = np.radians(s["lat"]), np.radians(s["lon"])

        # move from point to point using the current latitude, azimuth, angular distance
        la = np.arcsin(np.sin(la0) * np.cos(c) + np.cos(la0) * np.sin(c) * np.cos(az))

        # change the longitude after moving the latitude 
        lo = lo0 + np.arctan2(np.sin(az) * np.sin(c) * np.cos(la0),
                            np.cos(c) - np.sin(la0) * np.sin(la))

        # convert the new_latitude and new_longitude to X,Y point 
        x, y = ll_to_xy(np.degrees(la), np.degrees(lo))

        # convert XY to row col in pixels
        # it may produce fraction 
        # col =300.5 means 50% of the way centers between the 300 and 301
        col = (x - t.c) / t.a - 0.5 - col0
        row = (y - t.f) / t.e - 0.5 - row0

        # get the height of this point 
        # for every row[i,j] , col [i,j] get me the elevation value
        # store it in the h 
        # h contains the (720,999) samples holds the terrain height at each point 
        h = map_coordinates(dem, [row, col], order=1, mode="constant", cval=np.nan)



        # Compute the horizon angle to determin the visibility of the sun and earth at this point and determine if this point is blocked or not 
        prof = {}
        # for each point calculate the horizon at 4 heights [0,2,5,10] in meters 
        for m in MASTS:
            h0 = s["height_m"] + m
            # this formula calculates the angle between an observer and target point (terrain cell) 
            # By finding the maximum angle (ang.max(axis=1)) the algorithm can build a horizon profile 
            # where any subsequent terrain point with a lower angle is hidden (blocked from view) by the highest peak in front of it
            ang = np.degrees(np.arctan2((R + h) * np.cos(c) - (R + h0),
                                        (R + h) * np.sin(c)))
            ang = np.where(np.isnan(ang), -90.0, ang)       # off-map = no blocking = any null = -90 deg so it never blocks anything 
            # this gets the maximum angle you could see from that angle at that height 
            prof[str(m)] = np.round(ang.max(axis=1), 3).tolist()
        # store each result for each site 
        result[s["id"]] = dict(name=s["name"], lat=s["lat"], lon=s["lon"],
                            height_m=s["height_m"], az_step=AZ_STEP, horizon=prof) 
        
        p0 = np.array(prof["0"])
        # print(f"{s['name']:22s} horizon min/mean/max (deg): "
        #     f"{p0.min():6.2f} {p0.mean():6.2f} {p0.max():6.2f}")


# save all the needed horizon in a file to use it faster when we select a point 
(ROOT / "public").mkdir(exist_ok=True)
json.dump(result, open(ROOT / "public" / "horizons.json", "w"))
# print("saved public/horizons.json")