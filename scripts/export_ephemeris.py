import glob, json
#  file    , save in JSON format
#  matching , 
import numpy as np, spiceypy as sp
#numpy : store manipualted arrays , spiceypy : perform astronomical calculations using NASA SPICE


#to calculate the Sun's and Earth's positions relative to the Moon,
#calculate the Moon's orientation,
#and store all those results in a binary dataset covering two years at hourly intervals.

#Instead of calculating everything in the browser every time
#this Python script precomputes the values and saves them 

for pat in ["naif0012.tls", "pck00011.tpc", "de440s.bsp",
            "moon_de440*.tf", "moon_pa_de440*.bpc"]:
    for f in sorted(glob.glob(f"kernels/{pat}")):
        sp.furnsh(f)           # used for loding the kernals data to the SPICE so we can do astronomical calculations
                            # It loads a kernel into SPICE's kernel system, making its information available to subsequent calculations

START = "2027-01-01 00:00:00 UTC" # stating date , coordinated universal time     
N = 24 * (365 + 366)            # two years, hourly (2028 is a leap year)
STEP = 3600.0                 # in seconds , because SPICE uses ephemeris time (ET), measured in seconds, for its calculations.
et0 = sp.str2et(START)        # str2et() means string to ephemeris time.  string to ephemeris time 

out = np.zeros((N, 17), dtype=np.float32) # 17,544 row with 17 column to have the orientation and position of the earth moon and sun in each hour 
# 17 column : 
# 0-2 sun position (XYZ)
# 3-5 earth position (XYZ)
# 6-14 moon rotation matrix     
# 15 sun distance 
# 16 earth distance                 
# all stored in 32 not 64 --> less precision but faster 


for i in range(N): # O(17544) which is (24*(365 + 366)) each hour 

    et = et0 + i * STEP # calculcate the current time in et (ephemeris time), (step is 3600 second which is 1 hour)

    # spkpos calculates the position of one astronomical object relative to another 
    # spkpos (target , time , reference frame , aberration_correction , observer) returns position matrix in (KM) and one-way light time in seconds 
    sun, _ = sp.spkpos("SUN", et, "J2000", "LT+S", "MOON")  # calculate the sun position 
    earth, _ = sp.spkpos("EARTH", et, "J2000", "LT+S", "MOON") # calculate the earth position --- LT + S 
    # the light does not travel instantly so we add S to it to correct the error    
    # expressed in J2000 frame reference 
                                                        
    # pxform() calculates a rotation matrix that transforms coordinates from one reference frame into another
    # pxform(from_frame , to_frame, time_of_transformation) 
    rot = sp.pxform("MOON_ME", "J2000", et) # returns matrix represents the rotation matrix no position or distances
    out[i, 0:3], out[i, 3:6], out[i, 6:15] = sun, earth, rot.flatten()

    out[i, 15], out[i, 16] = np.linalg.norm(sun), np.linalg.norm(earth)
    # distances from the moon to the sun and earth (x,y,z) -> (0,0,0)
    # Euclidean length in 3D = sqrt(x^2 +y^2 +z^2) all in Kilo Meter

# export the pre-calculated positions and rotations and distances


out.tofile("public/ephemeris.bin") #move all the table to the ephemeris.bin to use it in the 3D and bin for binary for faster work
json.dump({"start": START, "et0": et0, "step_s": STEP, "n": N, # keep a JSON copy of description of the table with is metadata
           "columns": "sun[3] earth[3] rot_ME_to_J2000[9] sun_dist earth_dist (km)"},
          open("public/ephemeris.json", "w")) # data , write in ephemeris.json

# sanity check: sub-Earth point should be near lon 0, lat within about 7 deg
for i in (0, 2000, 5000): # Three points 
    et = et0 + i * STEP # calculate the time in et 
    p, _, _ = sp.subpnt("INTERCEPT/ELLIPSOID", "MOON", et, "MOON_ME", "LT+S", "EARTH")
    # subpnt : calculates a point on the surface of a target body -- target = moon , observer = earth , surface model : ellipsoid 
    # Where is the point on the Moon's surface that faces the Earth, at this particular time?
    # p: The position of the surface point relative to the Moon's center, expressed in MOON_ME.
    _, lon, lat = sp.reclat(p) # Converting Cartesian coordinates into spherical coordinates
    print(sp.et2utc(et, "C", 0), "sub-Earth lon/lat:",
          round(np.degrees(lon), 2), round(np.degrees(lat), 2))
print("done:", out.shape)