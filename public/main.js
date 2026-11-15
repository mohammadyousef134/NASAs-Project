import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import { PoleHeat } from './poletiles.js';
import { initRanking } from './ranking.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WINDOW_H = 336; // 14 days, must match WINDOW_H in rank_sites.py
const STRIDE = 17;          // floats per row in ephemeris.bin
// row = sun[3] earth[3] rot_MOON_ME_to_J2000[9, row-major] sun_dist earth_dist (km)
const EARTH_DIST = 8;       // overview scale: Moon radius = 1 unit
const EARTH_R = 1.1;        // exaggerated for visibility
const SUN_DIST = 40;
const DEG = Math.PI / 180;
const SUN_R_DEG = 0.267;    // apparent solar radius seen from the Moon
const EARTH_R_DEG = 0.95;   // apparent Earth radius seen from the Moon
const SOLAR_CONST = 1361;   // W/m2 at 1 AU
const AU_KM = 149597870.7;
const C_KMS = 299792.458;
const TEX = 'textures/';
// True sizes, in Moon radii (1 scene unit = 1 Moon radius = 1,737.4 km). Used by the two true-scale views.
const RM_KM = 1737.4;
const BODY_R = { moon: 1, earth: 6371.0 / RM_KM, sun: 695700.0 / RM_KM };

const $ = (id) => document.getElementById(id);
const showError = (msg) => { $('err').textContent = msg; console.error(msg); };

// ---------------------------------------------------------------------------
// Load data (serve this folder over http)
// ---------------------------------------------------------------------------
const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const [meta, buf, rawSites, rawHorizons] = await Promise.all([
  fetch('ephemeris.json').then((r) => r.json()),
  fetch('ephemeris.bin').then((r) => r.arrayBuffer()),
  getJson('sites.json'),
  getJson('horizons.json'),
]);

const f = new Float32Array(buf);
const N = meta.n;
if (f.length !== N * STRIDE) showError(`ephemeris.bin has ${f.length} floats, expected ${N * STRIDE}`);
const T0_MS = Date.parse(meta.start.replace(' UTC', 'Z').replace(' ', 'T'));
const STEP_H = meta.step_s / 3600;

// sites.json: array, {sites: []} or {id: {...}}
const siteArr = !rawSites ? [] : Array.isArray(rawSites) ? rawSites : (rawSites.sites ?? Object.values(rawSites));
const sites = siteArr
  .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
  .map((s) => ({
    id: String(s.id ?? s.name ?? 'site'),
    name: s.name ?? s.id ?? 'site',
    lat: s.lat,
    lon: s.lon,
    height: s.height_m ?? s.height ?? null,
    horizon: null,
  }));

// ---------------------------------------------------------------------------
// horizons.json: tolerant parser. Expects, per site, an array of terrain elevation angles (deg)
// at evenly spaced azimuths starting at North (0 deg) and increasing clockwise (East = 90 deg).
// If the file has several mast heights, the first array found is used.
// ---------------------------------------------------------------------------
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function firstNumericArray(o, depth = 0) {
  if (Array.isArray(o) && o.length >= 36 && o.every((v) => typeof v === 'number' || v === null)) return o;
  if (o && typeof o === 'object' && depth < 3) {
    const keys = Object.keys(o);
    // prefer keys that look like a bare horizon / the lowest mast
    keys.sort((a, b) => /horizon|elev|^el$|mast.?0|^0$|0m/i.test(b) - /horizon|elev|^el$|mast.?0|^0$|0m/i.test(a));
    for (const k of keys) {
      const r = firstNumericArray(o[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}
function attachHorizons(raw) {
  if (!raw) return 0;
  let entries = [];
  const root = Array.isArray(raw) ? raw : (raw.sites ?? raw);
  if (Array.isArray(root)) entries = root.map((e) => [e.id ?? e.name ?? e.site, e]);
  else entries = Object.entries(root);
  let hit = 0;
  for (const s of sites) {
    const e = entries.find(([k, v]) => norm(k) === norm(s.id) || norm(k) === norm(s.name) ||
      norm(v?.id) === norm(s.id) || norm(v?.name) === norm(s.name));
    const arr = e ? firstNumericArray(e[1]) : null;
    if (arr) { s.horizon = Float32Array.from(arr, (v) => (v ?? 0)); hit++; }
  }
  return hit;
}
const horizonHits = attachHorizons(rawHorizons);
if (horizonHits < sites.length) {
  showError(`horizons.json matched ${horizonHits}/${sites.length} sites; unmatched sites use a flat 0° horizon.`);
}

function horizonAt(site, azDeg) {
  const h = site.horizon;
  if (!h) return 0;
  const n = h.length;
  const x = (((azDeg % 360) + 360) % 360) / 360 * n;
  const i = Math.floor(x) % n;
  const a = x - Math.floor(x);
  return h[i] * (1 - a) + h[(i + 1) % n] * a;
}

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.domElement.id = 'scene';
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.0002, 3e6);
const OVERVIEW = new THREE.Vector3(6, 4, 14);
camera.position.copy(OVERVIEW);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0;          // the zoom limit is handled in the wheel handler below (it depends on which body we look at)
controls.enableZoom = false;       // zoom is handled below so that it is proportional to the HEIGHT above the Moon
controls.maxDistance = 1e7;

// Fallback star points (hidden once the Milky Way cube map has loaded)
const starPoints = (() => {
  const n = 2500;
  const p = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.randomDirection().multiplyScalar(300); p.set([v.x, v.y, v.z], i * 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.2, sizeAttenuation: false, color: 0x9aa8c4 }));
  scene.add(pts);
  return pts;
})();

// Sky: a dome that follows the camera and shows a whole-sky star map (equirectangular, 4K/8K).
// It is aligned to the real sky (J2000), so the Milky Way and stars sit where they really are.
// textures/sky.json says how the picture is laid out: { "frame": "galactic" | "equatorial", "flip": 1 | -1, "lon0": 0, "brightness": 1 }
// If no sky_8k.jpg / sky_4k.jpg exists, the old decorative cube map is used.
const skyUniforms = {
  uMap: { value: null }, uToMap: { value: new THREE.Matrix3() },
  uFlip: { value: 1 }, uLon0: { value: 0 }, uBright: { value: 1 },
};
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(1000, 48, 24),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms, side: THREE.BackSide, depthTest: false, depthWrite: false,
    vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform mat3 uToMap; uniform float uFlip, uLon0, uBright;
      varying vec3 vD;
      void main() {
        vec3 w = normalize(vD);
        vec3 s = vec3(w.x, -w.z, w.y);              // three.js world -> J2000 (Z = celestial north)
        vec3 g = normalize(uToMap * s);              // -> the frame the picture was drawn in
        float lon = atan(g.y, g.x), lat = asin(clamp(g.z, -1.0, 1.0));
        vec2 uv = vec2(0.5 - uFlip * (lon - uLon0) / 6.2831853, 0.5 + lat / 3.1415927);
        vec2 uvB = vec2(fract(uv.x + 0.5) - 0.5, uv.y);   // same point, but without the jump at the picture edge
        vec2 d1 = fwidth(uv), d2 = fwidth(uvB);
        bool useB = (d2.x + d2.y) < (d1.x + d1.y);
        vec2 u = useB ? uvB : uv;
        vec2 dx = useB ? dFdx(uvB) : dFdx(uv), dy = useB ? dFdy(uvB) : dFdy(uv);
        vec3 c = textureGrad(uMap, vec2(fract(u.x), u.y), dx, dy).rgb * uBright;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
skyDome.renderOrder = -1000;
skyDome.frustumCulled = false;
skyDome.visible = false;
scene.add(skyDome);

// ICRS (J2000) -> galactic rotation matrix (rows), used when the picture is in galactic coordinates
const M_GAL = [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669];

async function loadSky() {
  let cfg = { frame: 'galactic', flip: 1, lon0: 0, brightness: 1 };
  try { cfg = { ...cfg, ...(await (await fetch(TEX + 'sky.json')).json()) }; } catch { /* defaults */ }
  const big = renderer.capabilities.maxTextureSize >= 8192;
  const names = big ? ['sky_8k.jpg', 'sky_4k.jpg'] : ['sky_4k.jpg'];
  for (const n of names) {
    try {
      const t = await new THREE.TextureLoader().setPath(TEX).loadAsync(n);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      t.wrapS = THREE.RepeatWrapping;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      skyUniforms.uMap.value = t;
      if (cfg.frame === 'galactic') skyUniforms.uToMap.value.set(...M_GAL); else skyUniforms.uToMap.value.identity();
      skyUniforms.uFlip.value = cfg.flip;
      skyUniforms.uLon0.value = (cfg.lon0 || 0) * DEG;
      skyUniforms.uBright.value = cfg.brightness;
      skyDome.visible = true;
      scene.background = new THREE.Color(0x000000);
      starPoints.visible = false;
      console.log('sky texture:', n, cfg.frame);
      return;
    } catch { /* try the next one */ }
  }
  // fallback: decorative cube map (not aligned)
  new THREE.CubeTextureLoader().setPath(TEX).loadAsync(
    ['sky_px.jpg', 'sky_nx.jpg', 'sky_py.jpg', 'sky_ny.jpg', 'sky_pz.jpg', 'sky_nz.jpg'],
  ).then((cube) => {
    cube.colorSpace = THREE.SRGBColorSpace;
    scene.background = cube; scene.backgroundIntensity = 0.7; starPoints.visible = false;
  }).catch(() => { /* keep plain background + points */ });
}
loadSky();

// ---------------------------------------------------------------------------
// Frames: everything below `root` is SPICE coordinates (Z up).
// root converts SPICE -> three.js: (x, y, z) -> (x, z, -y).
// ---------------------------------------------------------------------------
const root = new THREE.Group();
root.matrixAutoUpdate = false;
root.matrix.set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
);
root.matrixWorldNeedsUpdate = true;
scene.add(root);

// Body-fixed vector for latitude/longitude (MOON_ME: +X lon 0, +Y lon 90E, +Z north)
function latLonToVec(latDeg, lonDeg, r = 1, target = new THREE.Vector3()) {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  return target.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).multiplyScalar(r);
}

const texLoader = new THREE.TextureLoader().setPath(TEX);
function loadTex(name, srgb = true) {
  const t = texLoader.load(name, undefined, undefined, () => console.warn('texture missing:', name));
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

// --- Moon (lives in MOON_ME, rotated into J2000 each frame) ---
const moon = new THREE.Group();
root.add(moon);

// rotateX(+90deg): Z-up sphere, lon 0 at +X, u = 0.5 at lon 0, u grows eastward (standard equirectangular map)
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 128, 64).rotateX(Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0xffffff, map: loadTex('moon_1024.jpg'), roughness: 1, metalness: 0 }),
);
moon.add(moonMesh);
// When the 3D relief is on, the smooth Moon ball is not drawn south of 80 S (the height tiles replace it there),
// otherwise deep craters would be hidden under the ball.
const moonHole = { value: 0 };
moonMesh.material.onBeforeCompile = (sh) => {
  sh.uniforms.uHole = moonHole;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vPoleZ;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPoleZ = position.z / length(position);');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPoleZ;\nuniform float uHole;')
    .replace('void main() {', `void main() {\n  if (uHole > 0.5 && vPoleZ < ${(-Math.cos(9.95 * DEG)).toFixed(6)}) discard;`);
};

// Progressive Moon colour texture: the small one shows at once, then a sharper one (8K if the GPU allows, else 4K) replaces it.
(async () => {
  const names = renderer.capabilities.maxTextureSize >= 8192 ? ['moon_8k.jpg', 'moon_4k.jpg'] : ['moon_4k.jpg'];
  for (const n of names) {
    try {
      const t = await new THREE.TextureLoader().setPath(TEX).loadAsync(n);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      const old = moonMesh.material.map;
      moonMesh.material.map = t;
      moonMesh.material.needsUpdate = true;
      if (old) old.dispose();
      console.log('moon texture:', n);
      return;
    } catch { /* not there, try the next */ }
  }
})();

function lineGeo(points) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return g;
}
function graticulePoints(radius) {
  const pts = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const seg = () => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -90; lat < 90; lat += 3) { latLonToVec(lat, lon, radius, a); latLonToVec(lat + 3, lon, radius, b); seg(); }
  }
  for (const lat of [-85, -80, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75]) {
    for (let lon = -180; lon < 180; lon += 3) { latLonToVec(lat, lon, radius, a); latLonToVec(lat, lon + 3, radius, b); seg(); }
  }
  return pts;
}
const graticule = new THREE.LineSegments(
  lineGeo(graticulePoints(1.002)),
  new THREE.LineBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.3 }),
);
moon.add(graticule);

// Prime meridian (Earth-facing centre line)
{
  const pts = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let lat = -90; lat < 90; lat += 2) {
    latLonToVec(lat, 0, 1.003, a); latLonToVec(lat + 2, 0, 1.003, b);
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  moon.add(new THREE.LineSegments(lineGeo(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })));
}

// South pole marker (cyan, so it is never confused with a selected site)
const markerGeo = new THREE.SphereGeometry(0.018, 16, 8);
let poleDot = null;           // the cyan dot on the south pole
{
  poleDot = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  poleDot.position.copy(latLonToVec(-90, 0, 1.0002));
  moon.add(poleDot);
}

// Site markers: a red map pin (like Google Maps) with the site name above it.
// Pins are sprites that keep the same size on screen at any zoom, so they are always easy to see and to click.
const PIN_H = 0.055;                 // pin height on screen (a fraction of the view height, roughly)
const PIN_W = PIN_H * (64 / 96);
const LABEL_H = 0.028;               // name text height on screen
function makePinTex(fill, edge, dot) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 192;
  const g = c.getContext('2d');
  // the pin: a round head that narrows to a point at the bottom (the point marks the exact site)
  g.beginPath();
  g.moveTo(64, 188);
  g.bezierCurveTo(52, 150, 10, 112, 10, 66);
  g.arc(64, 66, 54, Math.PI, 0);
  g.bezierCurveTo(118, 112, 76, 150, 64, 188);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.lineWidth = 6; g.strokeStyle = edge; g.stroke();
  g.beginPath(); g.arc(64, 66, 20, 0, 2 * Math.PI); g.fillStyle = dot; g.fill();   // the dark dot in the head
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const PIN_GRAY = makePinTex('#9a9a9a', '#5a5a5a', '#4a4a4a');   // normal: grey
const PIN_RED = makePinTex('#ea4335', '#a52714', '#7a1b0d');    // mouse over it, or selected: red, like Google Maps
let hovered = -1;                  // the pin under the mouse (-1 = none)
function makeNameLabel(text) {
  const font = '600 40px system-ui, sans-serif';
  const m = document.createElement('canvas').getContext('2d'); m.font = font;
  const w = Math.ceil(m.measureText(text).width) + 40;
  const c = document.createElement('canvas'); c.width = w; c.height = 64;
  const g = c.getContext('2d');
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineJoin = 'round';
  g.strokeText(text, w / 2, 33);                  // black outline: readable on bright and dark ground
  g.fillStyle = '#ffffff'; g.fillText(text, w / 2, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
  sp.userData.aspect = w / 64;
  sp.renderOrder = 31;
  return sp;
}
function sizeMarker(s, k) {          // k = 1 normal, bigger when selected
  s.pin.scale.set(PIN_W * k, PIN_H * k, 1);
  s.label.scale.set(LABEL_H * k * s.label.userData.aspect, LABEL_H * k, 1);
  s.label.center.set(0.5, -(PIN_H / LABEL_H) - 0.15);   // sits just above the pin head
}
const pickables = [];
for (const [i, s] of sites.entries()) {
  s.marker = new THREE.Group();                      // the exact site position; the pin and the name hang on it
  s.marker.position.copy(latLonToVec(s.lat, s.lon, 1.0002));
  moon.add(s.marker);
  s.pin = new THREE.Sprite(new THREE.SpriteMaterial({ map: PIN_GRAY, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
  s.pin.center.set(0.5, 0);                         // the tip of the pin is on the site
  s.pin.renderOrder = 30;
  s.pin.userData.index = i;
  s.label = makeNameLabel(s.name);
  s.marker.add(s.pin, s.label);
  sizeMarker(s, 1);
  pickables.push(s.pin);
}
// pins are drawn on top of everything, so hide the ones on the far side of the Moon (below the camera's horizon)
const _mp = new THREE.Vector3(); const _mc = new THREE.Vector3();
function updatePins() {
  bodyW('moon', _mc);
  for (const s of sites) {
    s.marker.getWorldPosition(_mp);
    const up = _mp.clone().sub(_mc);
    const show = camera.position.clone().sub(_mp).dot(up) > -1e-4 * up.length();
    s.marker.visible = show;
  }
  // grey pins with no name; the pin under the mouse (and the selected one) turns red and shows its name
  sites.forEach((st, i) => {
    const on = i === hovered || i === selected;
    if (st.pin.material.map !== (on ? PIN_RED : PIN_GRAY)) { st.pin.material.map = on ? PIN_RED : PIN_GRAY; st.pin.material.needsUpdate = true; }
    st.label.visible = on;
  });
}
const visiblePins = () => pickables.filter((p) => p.parent.visible);

// --- Earth: day texture + ocean specular, rotated by Earth Rotation Angle in the J2000 frame (+Z = pole) ---
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R, 64, 32).rotateX(Math.PI / 2),
  new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: loadTex('earth_atmos_2048.jpg'),
    specularMap: loadTex('earth_specular_2048.jpg', false),
    specular: new THREE.Color(0x3a3a3a),
    shininess: 18,
  }),
);
root.add(earth);

// Sun: a procedural, animated photosphere (granulation + sunspots + limb darkening) and a soft glow. No download needed.
const sunMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vP = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform float uTime;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    float h31(vec3 p){ p = fract(p*0.3183099+vec3(.1,.2,.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
    float vnoise(vec3 x){
      vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
      return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x), mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x), f.y),
                 mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x), mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x), f.y), f.z);
    }
    float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a*vnoise(p); p *= 2.03; a *= .5; } return s; }
    void main() {
      #include <logdepthbuf_fragment>
      float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
      float t = uTime * 0.03;
      float gran = fbm(vP*18.0 + vec3(0.0, t, 0.0)) * 0.6 + fbm(vP*60.0 + vec3(t*2.0, 0.0, 0.0)) * 0.4;
      float spots = smoothstep(0.62, 0.72, fbm(vP*3.0 + vec3(0.0, 0.0, t*0.2)));
      float limb = 1.0 - 0.62*(1.0-mu) - 0.2*(1.0-mu)*(1.0-mu);
      float heat = smoothstep(0.30, 0.72, gran) * (1.0 - 0.6*spots);
      vec3 col = mix(vec3(0.85, 0.30, 0.03), vec3(1.0, 0.80, 0.42), heat) * limb;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const sunBall = new THREE.Mesh(new THREE.SphereGeometry(1.6, 64, 32), sunMat);
root.add(sunBall);
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0.0, 'rgba(255,240,200,1)'); gr.addColorStop(0.18, 'rgba(255,190,90,0.35)');
  gr.addColorStop(0.45, 'rgba(255,140,50,0.08)'); gr.addColorStop(1.0, 'rgba(255,120,40,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
  }));
  glow.scale.setScalar(16);
  sunBall.add(glow);
}

const sunLight = new THREE.DirectionalLight(0xffffff, 3.2); // shines from its position toward the origin
root.add(sunLight);
scene.add(new THREE.AmbientLight(0x1b2740, 0.7));

// Orbit lines for the true-scale views, built once from the ephemeris (a point every 6 hours).
//   moonTrail  = the Moon's path around the Earth (drawn around the Earth)
//   earthTrail = the Earth's path around the Sun  (drawn around the Sun)
function trailLine(color, pointAt) {
  const pts = [];
  for (let i = 0; i < N; i += 6) pts.push(...pointAt(i * STRIDE));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
  line.frustumCulled = false;
  line.visible = false;
  root.add(line);
  return line;
}
const _vs = new THREE.Vector3();
const _ve = new THREE.Vector3();
const vecsAt = (o) => {            // Moon->Sun and Moon->Earth in Moon radii
  _vs.set(f[o], f[o + 1], f[o + 2]).normalize().multiplyScalar(f[o + 15] / RM_KM);
  _ve.set(f[o + 3], f[o + 4], f[o + 5]).normalize().multiplyScalar(f[o + 16] / RM_KM);
};
// The real Moon orbit is a slightly squashed ellipse that wobbles over the years. In the true-scale views we draw it as a clean
// circle instead: the plane is the average orbit plane of the 2 years, the radius is the average Earth-Moon distance, and the
// Moon is shown on that circle (its direction is the real one; its distance is rounded to the average, at most about 6 % off).
const ORBIT = (() => {
  const n = new THREE.Vector3(); const a = new THREE.Vector3(); const b = new THREE.Vector3(); let rSum = 0; let cnt = 0;
  for (let i = 0; i + 6 < N; i += 6) {
    vecsAt(i * STRIDE); a.copy(_ve).normalize();
    vecsAt((i + 6) * STRIDE); b.copy(_ve).normalize();
    n.add(a.cross(b));
    rSum += f[i * STRIDE + 16] / RM_KM; cnt++;
  }
  n.normalize();
  const e1 = new THREE.Vector3(1, 0, 0); if (Math.abs(n.x) > 0.9) e1.set(0, 1, 0);
  e1.sub(n.clone().multiplyScalar(e1.dot(n))).normalize();
  const e2 = n.clone().cross(e1);
  return { n, e1, e2, r: rSum / cnt };
})();
const moonTrail = (() => {
  const pts = [];
  for (let k = 0; k < 360; k++) {
    const t = (k / 360) * 2 * Math.PI;
    pts.push(...ORBIT.e1.clone().multiplyScalar(Math.cos(t) * ORBIT.r).addScaledVector(ORBIT.e2, Math.sin(t) * ORBIT.r).toArray());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xaab8d0, transparent: true, opacity: 0.6 }));
  line.frustumCulled = false; line.visible = false; root.add(line);
  return line;
})();
const earthTrail = trailLine(0x4fa0ff, (o) => { vecsAt(o); return [_ve.x - _vs.x, _ve.y - _vs.y, _ve.z - _vs.z]; });

// Name tags (constant size on screen) so the small bodies can be found in the true-scale views
function makeLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color; g.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, sizeAttenuation: false }));
  s.scale.set(0.12, 0.03, 1); s.center.set(0.5, -0.7); s.renderOrder = 20; s.visible = false;
  root.add(s);
  return s;
}
const labels = { moon: makeLabel('Moon', '#e6edf6'), earth: makeLabel('Earth', '#7fc0ff'), sun: makeLabel('Sun', '#ffd98a') };
// A small bright dot on each body, so it can be found even when it is far too small to see at true size
function makeDot(color) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, color); gr.addColorStop(0.35, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, sizeAttenuation: false }));
  s.scale.set(0.022, 0.022, 1); s.renderOrder = 19; s.visible = false;
  root.add(s);
  return s;
}
const dots = { moon: makeDot('#e6edf6'), earth: makeDot('#7fc0ff'), sun: makeDot('#ffe6a8') };

// ---------------------------------------------------------------------------
// Ephemeris lookups
// ---------------------------------------------------------------------------
const m4 = new THREE.Matrix4();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const sunDir = new THREE.Vector3();    // J2000, unit
const earthDir = new THREE.Vector3();  // J2000, unit

function rowQuat(i, out) {
  const o = i * STRIDE;
  m4.set(
    f[o + 6], f[o + 7], f[o + 8], 0,
    f[o + 9], f[o + 10], f[o + 11], 0,
    f[o + 12], f[o + 13], f[o + 14], 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(m4);
}

const L = THREE.MathUtils.lerp;
// Fills J2000 unit vectors and distances, and the Moon quaternion, for fractional hour index hc.
function ephemerisAt(hc, sunOut, earthOut, quatOut) {
  hc = THREE.MathUtils.clamp(hc, 0, N - 1);
  const i0 = Math.floor(hc);
  const i1 = Math.min(i0 + 1, N - 1);
  const a = hc - i0;
  const o0 = i0 * STRIDE;
  const o1 = i1 * STRIDE;
  sunOut.set(L(f[o0], f[o1], a), L(f[o0 + 1], f[o1 + 1], a), L(f[o0 + 2], f[o1 + 2], a)).normalize();
  earthOut.set(L(f[o0 + 3], f[o1 + 3], a), L(f[o0 + 4], f[o1 + 4], a), L(f[o0 + 5], f[o1 + 5], a)).normalize();
  quatOut.copy(rowQuat(i0, qa)).slerp(rowQuat(i1, qb), a);
  return { sunKm: L(f[o0 + 15], f[o1 + 15], a), earthKm: L(f[o0 + 16], f[o1 + 16], a) };
}

// Earth Rotation Angle (radians) for a UTC time; precession/nutation ignored (< 0.5 deg over the range)
function earthRotationAngle(ms) {
  const tu = ms / 86400000 + 2440587.5 - 2451545.0;
  const turns = 0.7790572732640 + 1.00273781191135448 * tu;
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}

// ---- Site geometry: local East/North/Up in MOON_ME and az/el of a body-fixed direction ----
const _u = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
function siteFrame(site) {
  if (site._frame) return site._frame;
  latLonToVec(site.lat, site.lon, 1, _u);
  _n.copy(Z).addScaledVector(_u, -Z.dot(_u)).normalize();
  _e.crossVectors(_n, _u);
  site._frame = { u: _u.clone(), n: _n.clone(), e: _e.clone() };
  return site._frame;
}
function azEl(site, dirME) {
  const fr = siteFrame(site);
  const up = dirME.dot(fr.u);
  const az = Math.atan2(dirME.dot(fr.e), dirME.dot(fr.n)) / DEG;
  return { el: Math.asin(THREE.MathUtils.clamp(up, -1, 1)) / DEG, az: (az + 360) % 360 };
}

const _qs = new THREE.Quaternion();
const _sj = new THREE.Vector3();
const _ej = new THREE.Vector3();
const _sm = new THREE.Vector3();
const _em = new THREE.Vector3();

// Full state of a site at fractional hour index hc
function evalSite(site, hc) {
  const d = ephemerisAt(hc, _sj, _ej, _qs);
  _qs.invert();
  _sm.copy(_sj).applyQuaternion(_qs);
  _em.copy(_ej).applyQuaternion(_qs);
  const s = azEl(site, _sm);
  const e = azEl(site, _em);
  const hS = horizonAt(site, s.az);
  const hE = horizonAt(site, e.az);
  // Fraction of the Sun's disc above the terrain (linear approximation across the disc)
  const sunFrac = THREE.MathUtils.clamp((s.el + SUN_R_DEG - hS) / (2 * SUN_R_DEG), 0, 1);
  const cosEps = _sm.dot(_em); // angle Sun-Moon-Earth, for the Earth's phase
  return {
    sunEl: s.el, sunAz: s.az, hSun: hS, sunFrac,
    earthEl: e.el, earthAz: e.az, hEarth: hE, earthUp: e.el > hE,
    sunKm: d.sunKm, earthKm: d.earthKm, cosEps,
  };
}

// ---------------------------------------------------------------------------
// Scene update per frame
// ---------------------------------------------------------------------------
const tmpQ = new THREE.Quaternion();
const state = { sub: '' };
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const view = { mode: 'moon', focus: 'moon', free: false };   // mode: moon | earth | sun
const sunP = new THREE.Vector3(); const earthP = new THREE.Vector3(); const moonP = new THREE.Vector3();  // scene positions (J2000 axes)
function setHour(h) {
  const hc = THREE.MathUtils.clamp(h, 0, N - 1);
  const d = ephemerisAt(hc, sunDir, earthDir, tmpQ);
  moon.quaternion.copy(tmpQ);

  if (view.mode === 'moon') {
    // Moon surface view: the Moon stays in the middle; Earth and Sun are drawn closer and bigger so they are easy to see
    moonP.set(0, 0, 0);
    earthP.copy(earthDir).multiplyScalar(EARTH_DIST);
    sunP.copy(sunDir).multiplyScalar(SUN_DIST);
  } else {
    // True-scale views: real distances from the ephemeris. mE = Moon -> Earth, mS = Moon -> Sun (both in Moon radii)
    // Moon -> Earth on the clean circle: real direction, flattened into the average orbit plane, average distance
    const mE = _v1.copy(earthDir);
    mE.addScaledVector(ORBIT.n, -mE.dot(ORBIT.n)).normalize().multiplyScalar(ORBIT.r);
    const mS = _v2.copy(sunDir).multiplyScalar(d.sunKm / RM_KM);
    if (view.mode === 'earth') { earthP.set(0, 0, 0); moonP.copy(mE).negate(); sunP.copy(mS).sub(mE); }
    else { sunP.set(0, 0, 0); moonP.copy(mS).negate(); earthP.copy(moonP).add(mE); }
  }
  moon.position.copy(moonP);
  earth.position.copy(earthP);
  earth.rotation.z = earthRotationAngle(T0_MS + hc * STEP_H * 3600e3);
  sunBall.position.copy(sunP);
  sunLight.position.copy(sunDir).multiplyScalar(SUN_DIST);   // only the direction matters for a directional light

  const when = new Date(T0_MS + hc * STEP_H * 3600e3);
  $('date').textContent = when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// ---------------------------------------------------------------------------
// Camera flights and views
// ---------------------------------------------------------------------------
// A flight moves the camera smoothly to an offset (rel) from a body. Direction turns smoothly and the distance changes
// in a logarithmic way, so a flight from 20 km to 200,000 km does not rush through the first part.
let flight = null;
const bodyObj = { moon: moon, earth: earth, sun: sunBall };
const _w = new THREE.Vector3();
const bodyW = (name, out = new THREE.Vector3()) => bodyObj[name].getWorldPosition(out);
const bodyRadiusNow = (name) => (view.mode === 'moon' ? { moon: 1, earth: EARTH_R, sun: 1.6 }[name] : BODY_R[name]);
function flyTo(rel, focus = 'moon', secs = 1.1) {
  if (view.free) setFree(false);
  const tFrom = controls.target.clone();
  const relFrom = camera.position.clone().sub(tFrom);
  flight = {
    t: 0, secs, focus, tFrom, lenFrom: relFrom.length(), lenTo: rel.length(),
    dirFrom: relFrom.clone().normalize(), dirTo: rel.clone().normalize(),
  };
  view.focus = focus;
  $('focus').value = focus;
}
function worldDirOfLatLon(lat, lon) {      // direction from the Moon's centre to a point on its surface, in world axes
  const v = latLonToVec(lat, lon);
  moon.updateWorldMatrix(true, false);
  return moon.localToWorld(v).sub(bodyW('moon')).normalize();
}
const PRESET = {                            // overview offsets (from the focus body), in Moon radii
  moon: { moon: OVERVIEW.clone() },
  earth: { earth: new THREE.Vector3(360, 560, 440), moon: new THREE.Vector3(4, 3, 7) },
  sun: { sun: new THREE.Vector3(0.3, 0.8, 0.5).multiplyScalar(2.6e5), earth: new THREE.Vector3(40, 30, 60) },
};
const FOCUS_DIST = () => (view.mode === 'moon'
  ? { moon: 15.7, earth: 5, sun: 8 } : { moon: 6, earth: 14, sun: 1700 });

function setView(mode) {
  const old = controls.target.clone();
  const rel = camera.position.clone().sub(old);
  view.mode = mode;
  const trueScale = mode !== 'moon';
  earth.scale.setScalar(trueScale ? BODY_R.earth / EARTH_R : 1);
  sunBall.scale.setScalar(trueScale ? BODY_R.sun / 1.6 : 1);
  moonTrail.visible = mode === 'earth' || mode === 'sun';
  earthTrail.visible = mode === 'sun';
  for (const k of Object.keys(labels)) { labels[k].visible = trueScale; dots[k].visible = trueScale; }
  setHour(hour);
  moon.updateMatrixWorld(true);
  // keep the camera where it was relative to the focus body, then fly to the overview of the new view
  const focus = mode === 'moon' ? 'moon' : (mode === 'earth' ? 'earth' : 'sun');
  view.focus = focus;
  controls.target.copy(bodyW(focus));
  camera.position.copy(controls.target).add(rel);
  flight = null;
  flyTo(PRESET[mode][focus].clone(), focus, 1.6);
}
$('viewMode').onchange = (e) => setView(e.target.value);
$('focus').onchange = (e) => {
  const to = e.target.value;
  const t = bodyW(to);
  const dir = camera.position.clone().sub(t);
  if (dir.lengthSq() < 1e-12) dir.set(0.3, 0.8, 0.5);
  flyTo(dir.normalize().multiplyScalar(FOCUS_DIST()[to]), to);
};
$('vOver').onclick = () => { const f = view.mode === 'moon' ? 'moon' : view.mode; flyTo(PRESET[view.mode][f].clone(), f); };
$('vPole').onclick = () => flyTo(worldDirOfLatLon(-90, 0).multiplyScalar(2.4), 'moon');
$('vEarth').onclick = () => flyTo(bodyW('earth').sub(bodyW('moon')).normalize().multiplyScalar(3), 'moon');

// Free fly camera (W/S forward-back, A/D left-right, R/F up-down, Q/E roll, drag = look). Speed follows the height above
// the nearest body, so you slow down automatically near the ground.
const fly = new FlyControls(camera, renderer.domElement);
fly.dragToLook = true; fly.rollSpeed = 0.7; fly.enabled = false;

// Mouse look for free fly, written by us instead of the one inside FlyControls.
// FlyControls keeps turning while the button is held (the further from the centre, the faster), and if the button is
// released outside the 3D view it never hears the release, so the camera kept turning forever.
// Here the camera turns only by how far the mouse MOVED, and every way a drag can end stops it.
for (const [type, fn] of [['pointerdown', fly._onPointerDown], ['pointermove', fly._onPointerMove],
  ['pointerup', fly._onPointerUp], ['pointercancel', fly._onPointerCancel]]) renderer.domElement.removeEventListener(type, fn);
const LOOK_SPEED = 0.0035;          // radians per pixel of mouse movement
let lookDrag = null;                // the pointer that is dragging, or null
function stopLook() {
  if (lookDrag && renderer.domElement.hasPointerCapture(lookDrag.id)) renderer.domElement.releasePointerCapture(lookDrag.id);
  lookDrag = null;
}
function stopFlyKeys() {             // also forget held keys (a key released while the window was not focused)
  for (const k in fly._moveState) fly._moveState[k] = 0;
  fly._updateMovementVector(); fly._updateRotationVector();
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();  // keys go to the 3D view again
  if (!view.free || e.button !== 0) return;
  lookDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);      // we hear the release even outside the view
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!lookDrag || e.pointerId !== lookDrag.id) return;
  if (!view.free || !(e.buttons & 1)) { stopLook(); return; }
  const dx = e.clientX - lookDrag.x; const dy = e.clientY - lookDrag.y;
  lookDrag.x = e.clientX; lookDrag.y = e.clientY;
  camera.rotateY(-dx * LOOK_SPEED);
  camera.rotateX(-dy * LOOK_SPEED);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) renderer.domElement.addEventListener(type, stopLook);
window.addEventListener('blur', () => { stopLook(); stopFlyKeys(); });

// Arrow keys: when a dropdown or slider still has the focus, the arrows changed it AND turned the camera.
// Now the arrows never change a dropdown; they only turn the camera (free fly).
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  if (!el || !e.key.startsWith('Arrow')) return;
  if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'range')) { e.preventDefault(); el.blur(); }
}, true);
// after picking from any dropdown, give the focus back to the page
document.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => s.blur()));
// how far the 3D relief lifts the ground under a world position (Moon radii; 0 when the relief is off)
const _gl = new THREE.Vector3();
function groundLift(worldPos) {
  const layer = pole.group.visible ? pole : poleGray.group.visible ? poleGray : null;
  return layer ? layer.liftAt(moon.worldToLocal(_gl.copy(worldPos))) : 0;
}
// The ground's distance from the Moon's centre under a Moon-fixed direction, measured on the tiles that are
// actually drawn (a ray from above, straight down). Used to stand the rocket exactly on the visible ground.
const _gr = new THREE.Raycaster(); const _gd = new THREE.Vector3(); const _go = new THREE.Vector3();
function groundRadiusAt(dirLocal) {
  const layer = pole.group.visible ? pole : poleGray.group.visible ? poleGray : null;
  if (!layer || !layer.reliefOn) return 1;
  moon.updateMatrixWorld(true);
  const c = bodyW('moon', new THREE.Vector3());
  moon.localToWorld(_go.copy(dirLocal).normalize().multiplyScalar(1.05));     // a point high above the place, in world axes
  _gd.copy(c).sub(_go).normalize();                                           // straight down
  _gr.set(_go, _gd); _gr.far = 0.2;
  const hit = _gr.intersectObjects(layer.group.children.filter((m) => m.visible), false)[0];
  return hit ? hit.point.distanceTo(c) : 1 + layer.liftAt(dirLocal);
}
function nearestAlt() {
  let best = 1e9;
  for (const k of ['moon', 'earth', 'sun']) best = Math.min(best, camera.position.distanceTo(bodyW(k, _w)) - bodyRadiusNow(k));
  best -= groundLift(camera.position);                                   // height above the real ground, not above the smooth ball
  return Math.max(best, 1e-5);
}
let locked = false;      // camera is carried along with the Moon's surface (only in free-fly mode)
function setLock(on) {
  locked = on && view.free;
  $('lock').classList.toggle('sel', locked);
  $('lock').textContent = locked ? 'Locked to the site (click to unlock)' : 'Lock to the site';
}
$('lock').onclick = () => setLock(!locked);
function setFree(on) {
  view.free = on;
  stopLook(); stopFlyKeys();
  if (!on) setLock(false);
  flight = null;
  controls.enabled = !view.free;
  fly.enabled = view.free;
  $('free').classList.toggle('sel', view.free);
  $('free').textContent = view.free ? 'Free fly: ON (click to stop)' : 'Free fly';
  $('freeHelp').style.display = view.free ? 'block' : 'none';
  if (!view.free) controls.target.copy(bodyW(view.focus));
}
$('free').onclick = () => setFree(!view.free);

// ---------------------------------------------------------------------------
// Site selection: the pin gets bigger, fly to the site, open the info card
// ---------------------------------------------------------------------------
let selected = -1;
let ranking = null;        // the ranking panel (ranking.js), created after the UI is ready
const siteButtons = [];
function select(i) {
  if (selected >= 0) {
    sizeMarker(sites[selected], 1);
    siteButtons[selected].classList.remove('sel');
  }
  selected = i;
  if (i < 0) { $('card').style.display = 'none'; return; }
  const s = sites[i];
  sizeMarker(s, 1.35);                       // the selected pin is bigger
  siteButtons[i].classList.add('sel');
  // Go straight to the site in free-fly mode, a little above the ground, looking at the Sun (or along the horizon toward it)
  if (!view.free) setFree(true);
  setLock(false);
  moon.updateMatrixWorld(true);
  const moonC = bodyW('moon', new THREE.Vector3());
  const P = s.marker.getWorldPosition(new THREE.Vector3());
  const up = P.clone().sub(moonC).normalize();
  const toSun = bodyW('sun', new THREE.Vector3()).sub(moonC).normalize();
  const look = toSun.clone();
  if (look.dot(up) < 0) look.addScaledVector(up, -look.dot(up));      // Sun below the horizon: look along the horizon instead
  look.normalize();
  camera.position.copy(P).addScaledVector(up, 0.002 + Math.max(0, groundLift(P)));   // stand above the real ground
  camera.up.copy(up);
  camera.lookAt(camera.position.clone().add(look));
  controls.target.copy(moonC);
  view.focus = 'moon'; $('focus').value = 'moon';

  $('cName').textContent = s.name;
  $('cCoords').textContent =
    (s.height != null ? `Elevation ${Math.round(s.height)} m` : '') +
    (s.horizon ? '' : `${s.height != null ? ' · ' : ''}no terrain data (flat horizon)`);
  // Optional real picture: put site_photos/<site id>.jpg next to index.html
  const img = $('photo');
  img.style.display = 'none';
  img.onload = () => { img.style.display = 'block'; };
  img.onerror = () => { img.style.display = 'none'; };
  img.src = `site_photos/${s.id}.jpg`;
  $('card').style.display = 'block';
  lastScan = { hour: -1e9, site: -1 };
  lookInit = false;
}
$('close').onclick = () => select(-1);

for (const [i, s] of sites.entries()) {
  const b = document.createElement('button');
  b.textContent = s.name;
  b.onclick = () => select(i);
  $('sites').appendChild(b);
  siteButtons.push(b);
}

// Picking: a click (not a drag) on a pin; pins on the far side of the Moon are hidden and cannot be clicked
const raycaster = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
  down = null;
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ptr, camera);
  const hit = raycaster.intersectObjects(visiblePins(), false)[0];
  if (hit) select(hit.object.userData.index);
});
renderer.domElement.addEventListener('pointerleave', () => { hovered = -1; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ptr, camera);
  const hit = raycaster.intersectObjects(visiblePins(), false)[0];
  hovered = hit ? hit.object.userData.index : -1;
  renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
});

// ---------------------------------------------------------------------------
// Site card: live numbers, sky view, 30-day timeline
// ---------------------------------------------------------------------------
let lastScan = { hour: -1e9, site: -1 };
let scan = null;         // {sunUp:Uint8Array, earthUp:Uint8Array}
let lookInit = false;
const SCAN_H = 720;      // 30 days, hourly

function runScan(site, hour) {
  const start = Math.floor(hour);
  const sunUp = new Uint8Array(SCAN_H);
  const earthUp = new Uint8Array(SCAN_H);
  for (let k = 0; k < SCAN_H; k++) {
    if (start + k > N - 1) { sunUp[k] = 2; earthUp[k] = 2; continue; } // 2 = beyond data
    const r = evalSite(site, start + k);
    sunUp[k] = r.sunFrac > 0 ? 1 : 0;
    earthUp[k] = r.earthUp ? 1 : 0;
  }
  scan = { sunUp, earthUp, start };
}
const pct = (arr, n) => {
  let c = 0; let m = 0;
  for (let k = 0; k < Math.min(n, arr.length); k++) { if (arr[k] !== 2) { m++; c += arr[k]; } }
  return m ? (100 * c) / m : NaN;
};
function nextChange(arr) {
  const cur = arr[0];
  for (let k = 1; k < arr.length; k++) { if (arr[k] === 2) return null; if (arr[k] !== cur) return k; }
  return null;
}
const fmtH = (h) => (h == null ? '> 30 days' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h} h`);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');

function drawStrip() {
  const c = $('strip'); if (!c) return; const g = c.getContext('2d');
  g.fillStyle = '#0d0d0d'; g.fillRect(0, 0, c.width, c.height);
  for (let k = 0; k < SCAN_H; k++) {
    if (scan.sunUp[k] === 1) { g.fillStyle = '#ffffff'; g.fillRect(k, 6, 1, 18); }
    if (scan.earthUp[k] === 1) { g.fillStyle = '#8a8a8a'; g.fillRect(k, 30, 1, 18); }
  }
  g.strokeStyle = '#4a4a4a'; g.fillStyle = '#8a8a8a'; g.font = '11px system-ui, sans-serif';
  for (let d = 0; d <= 30; d += 1) {
    const x = d * 24;
    g.beginPath(); g.moveTo(x + 0.5, d % 5 === 0 ? 50 : 54); g.lineTo(x + 0.5, 58); g.stroke();
    if (d % 5 === 0 && d < 30) g.fillText(`+${d}d`, x + 3, 60);
  }
}

// ---- sky view: rectilinear-ish panorama, 10 px per degree in both axes (true scale) ----
const PX = 10;
const EL_MIN = -6;
const stars = (() => { // deterministic stars in azimuth/elevation
  const out = []; let s = 12345;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 260; i++) out.push({ az: r() * 360, el: r() * 40 - 8, m: 0.25 + r() * 0.55 });
  return out;
})();
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

function drawView(site, ev, lookAz) {
  const c = $('view'); const g = c.getContext('2d');
  const W = c.width; const H = c.height;
  const X = (az) => W / 2 + angDiff(az, lookAz) * PX;
  const Y = (el) => H - (el - EL_MIN) * PX;

  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#000000'); sky.addColorStop(1, '#0d0d0d');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);

  for (const s of stars) {
    const x = X(s.az);
    if (x < -2 || x > W + 2) continue;
    g.fillStyle = `rgba(230,230,230,${s.m})`; g.fillRect(x, Y(s.el), 1.4, 1.4);
  }

  // Earth, with its phase (lit side towards the Sun)
  {
    const x = X(ev.earthAz); const y = Y(ev.earthEl); const r = EARTH_R_DEG * PX;
    if (x > -40 && x < W + 40) {
      const dx = angDiff(ev.sunAz, ev.earthAz); const dy = -(ev.sunEl - ev.earthEl);
      const th = Math.atan2(dy, dx);
      const cosI = -ev.cosEps; // phase angle i = 180 - epsilon
      g.save(); g.translate(x, y); g.rotate(th);
      g.fillStyle = '#0b1b33'; g.beginPath(); g.arc(0, 0, r, 0, 2 * Math.PI); g.fill();
      g.fillStyle = '#4f93e8'; g.beginPath(); g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2); g.fill();
      g.fillStyle = cosI > 0 ? '#4f93e8' : '#0b1b33';
      g.beginPath(); g.ellipse(0, 0, Math.max(0.01, r * Math.abs(cosI)), r, 0, 0, 2 * Math.PI); g.fill();
      g.restore();
    }
  }
  // Sun: true disc plus glow
  {
    const x = X(ev.sunAz); const y = Y(ev.sunEl); const r = SUN_R_DEG * PX;
    if (x > -60 && x < W + 60) {
      const glow = g.createRadialGradient(x, y, 0, x, y, 46);
      glow.addColorStop(0, 'rgba(255,230,160,0.55)'); glow.addColorStop(1, 'rgba(255,230,160,0)');
      g.fillStyle = glow; g.fillRect(x - 46, y - 46, 92, 92);
      g.fillStyle = '#fff6d6'; g.beginPath(); g.arc(x, y, Math.max(r, 2.2), 0, 2 * Math.PI); g.fill();
    }
  }
  // Terrain silhouette (drawn after the bodies, so anything below the horizon is hidden)
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += 2) g.lineTo(x, Y(horizonAt(site, lookAz + (x - W / 2) / PX)));
  g.lineTo(W, H); g.closePath();
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#4a4a50'); gr.addColorStop(1, '#17171b');
  g.fillStyle = gr; g.fill();
  g.strokeStyle = '#8c8c96'; g.lineWidth = 1.2; g.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const y = Y(horizonAt(site, lookAz + (x - W / 2) / PX));
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // Azimuth ticks + compass letters
  g.fillStyle = '#b0b0b0'; g.font = '12px system-ui, sans-serif'; g.strokeStyle = 'rgba(176,176,176,.5)';
  const first = Math.ceil((lookAz - 40) / 5) * 5;
  for (let a = first; a <= lookAz + 40; a += 5) {
    const x = X(a); const aa = ((a % 360) + 360) % 360;
    g.beginPath(); g.moveTo(x + 0.5, H); g.lineTo(x + 0.5, H - (aa % 15 === 0 ? 9 : 5)); g.stroke();
    if (aa % 15 === 0) {
      const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[aa] ?? `${aa}°`;
      g.fillText(lbl, x - g.measureText(lbl).width / 2, H - 12);
    }
  }
  // Elevation scale (every 5 degrees)
  g.fillStyle = '#8a8a8a';
  for (let el = 0; el <= 15; el += 5) {
    g.fillText(`${el}°`, 4, Y(el) - 2);
    g.fillStyle = 'rgba(138,138,138,.25)'; g.fillRect(0, Y(el), W, 1); g.fillStyle = '#8a8a8a';
  }
}

let lastCardUpdate = 0;
function updateCard(hour, now) {
  if (selected < 0) return;
  const site = sites[selected];
  if (now - lastCardUpdate < 90) return;
  lastCardUpdate = now;

  const ev = evalSite(site, hour);

  if (Math.abs(hour - lastScan.hour) >= 1 || lastScan.site !== selected) {
    runScan(site, hour);
    lastScan = { hour, site: selected };
  }

  if (!lookInit) { // first view after selecting: face the Sun
    $('lookAz').value = String(Math.round(ev.sunAz));
    lookInit = true;
  }
  drawView(site, ev, Number($('lookAz').value));

  // Sunlight
  const au2 = (AU_KM / ev.sunKm) ** 2;
  const sinEl = Math.max(0, Math.sin(ev.sunEl * DEG));
  const flux = SOLAR_CONST * au2 * ev.sunFrac;
  const horizPanel = flux * sinEl;
  const vertPanel = flux * Math.max(0, Math.cos(Math.max(0, ev.sunEl) * DEG));
  const sunCls = ev.sunFrac >= 0.999 ? 'ok' : ev.sunFrac > 0 ? 'mid' : 'bad';
  $('kSun').className = 'v ' + sunCls;
  $('kSun').textContent = ev.sunFrac >= 0.999 ? 'Lit' : ev.sunFrac > 0 ? `Partly (${Math.round(ev.sunFrac * 100)}%)` : 'Shadow';
  $('kSunD').innerHTML =
    (ev.sunFrac > 0 ? `${Math.round(vertPanel)} W/m² on a vertical panel` : 'no direct sunlight');

  // Earth
  const eCls = ev.earthUp ? 'ok' : 'bad';
  $('kEarth').className = 'v ' + eCls;
  $('kEarth').textContent = ev.earthUp ? 'Visible' : 'Blocked';
  $('kEarthD').innerHTML =
    (ev.earthUp ? `${ev.earthEl.toFixed(0)}° above the horizon` : 'hidden behind terrain');

  const nSun = nextChange(scan.sunUp); const nEarth = nextChange(scan.earthUp);
  const sunNow = scan.sunUp[0] === 1;
  const earthNow = scan.earthUp[0] === 1;
  $('stats').innerHTML =
    `<tr><td>${sunNow ? 'Sun sets in' : 'Sun rises in'}</td><td>${fmtH(nSun)}</td></tr>` +
    `<tr><td>${earthNow ? 'Earth link lost in' : 'Earth link starts in'}</td><td>${fmtH(nEarth)}</td></tr>` +
    `<tr><td>Next 14 days: Sun visible</td><td>${f1(pct(scan.sunUp, WINDOW_H))} %</td></tr>` +
    `<tr><td>Next 14 days: Earth visible</td><td>${f1(pct(scan.earthUp, WINDOW_H))} %</td></tr>` +
    `<tr><td>Next 30 days: Sun visible</td><td>${f1(pct(scan.sunUp, SCAN_H))} %</td></tr>` +
    `<tr><td>Next 30 days: Earth visible</td><td>${f1(pct(scan.earthUp, SCAN_H))} %</td></tr>`;
  $('viewNote').textContent =
    (site.horizon ? 'Terrain silhouette from the LOLA DEM horizon profile; ' : 'No horizon data, flat 0° horizon; ') +
    'Sun and Earth are drawn at their true angular size. This is a computed view, not a photograph.';
}
$('lookSun').onclick = () => { if (selected >= 0) $('lookAz').value = String(Math.round(evalSite(sites[selected], hour).sunAz)); lastCardUpdate = 0; };
$('lookEarth').onclick = () => { if (selected >= 0) $('lookAz').value = String(Math.round(evalSite(sites[selected], hour).earthAz)); lastCardUpdate = 0; };
$('lookAz').oninput = () => { lastCardUpdate = 0; };

// ---------------------------------------------------------------------------
// UI + loop
// ---------------------------------------------------------------------------
const slider = $('t');
slider.max = String(N - 1);
let hour = 0;
let playing = false;

slider.oninput = () => { hour = slider.valueAsNumber; };

// Calendar: the data covers the 2 years only; later days up to the end of 2030 are shown but locked (demo limit, not a technical one)
const MS_H = STEP_H * 3600e3;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400e3;
const dayMs = (iso) => Date.parse(iso + 'T00:00:00Z');
const FIRST_DAY = dayMs(isoDay(T0_MS));
const LAST_DAY = dayMs(isoDay(T0_MS + (N - 1) * MS_H));
const CAL_END = Date.UTC(new Date(FIRST_DAY).getUTCFullYear() + 3, 11, 31);     // end of the 4th year (2030)
const pick = $('pick'); const calBox = $('cal');
let calY = new Date(FIRST_DAY).getUTCFullYear(); let calM = new Date(FIRST_DAY).getUTCMonth();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function renderCal() {
  const first = Date.UTC(calY, calM, 1);
  const lead = (new Date(first).getUTCDay() + 6) % 7;                 // week starts on Monday
  const nDays = new Date(Date.UTC(calY, calM + 1, 0)).getUTCDate();
  const cur = dayMs(isoDay(T0_MS + hour * MS_H));
  const canPrev = first > Date.UTC(new Date(FIRST_DAY).getUTCFullYear(), new Date(FIRST_DAY).getUTCMonth(), 1);
  const canNext = Date.UTC(calY, calM + 1, 1) <= CAL_END;
  let h = `<div class="calHead"><button data-nav="-1" ${canPrev ? '' : 'disabled'}>‹</button><span class="calSel"><select id="calMonth">${MONTHS.map((m, i) => `<option value="${i}" ${i === calM ? 'selected' : ''}>${m}</option>`).join('')}</select>` +
    `<select id="calYear">${Array.from({ length: 4 }, (_, k) => { const y = new Date(FIRST_DAY).getUTCFullYear() + k; return `<option value="${y}" ${y === calY ? 'selected' : ''}>${y}${Date.UTC(y, 0, 1) > LAST_DAY ? ' 🔒' : ''}</option>`; }).join('')}</select></span>` +
    `<button data-nav="1" ${canNext ? '' : 'disabled'}>›</button></div><div class="calGrid">` +
    ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<i>${d}</i>`).join('') + '<span></span>'.repeat(lead);
  for (let d = 1; d <= nDays; d++) {
    const t = Date.UTC(calY, calM, d);
    const state = t < FIRST_DAY ? 'off' : t > LAST_DAY ? 'lock' : 'ok';
    h += `<button class="day ${state}${t === cur ? ' cur' : ''}" data-d="${t}">${state === 'lock' ? '🔒' : d}</button>`;
  }
  h += '</div><div class="calNote" id="calNote">Computed for 2027–2028. Later dates are locked for this presentation; the pipeline can compute any range.</div>';
  calBox.innerHTML = h;
}
calBox.onchange = (e) => {
  if (e.target.id === 'calMonth') calM = Number(e.target.value);
  if (e.target.id === 'calYear') calY = Number(e.target.value);
  renderCal();
};
calBox.onclick = (e) => {
  e.stopPropagation();                // the box is re-drawn on every click, so the outside-click check below would misfire
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.nav) {
    calM += Number(t.dataset.nav);
    if (calM < 0) { calM = 11; calY--; } if (calM > 11) { calM = 0; calY++; }
    renderCal(); return;
  }
  if (!t.dataset.d || t.classList.contains('off')) return;
  if (t.classList.contains('lock')) { $('calNote').classList.add('flash'); setTimeout(() => $('calNote')?.classList.remove('flash'), 700); return; }
  hour = THREE.MathUtils.clamp((Number(t.dataset.d) - T0_MS) / MS_H, 0, N - 1);
  slider.value = String(hour);
  calBox.style.display = 'none';
};
pick.onclick = (e) => {
  e.stopPropagation();
  if (calBox.style.display === 'block') { calBox.style.display = 'none'; return; }
  const c = new Date(T0_MS + hour * MS_H); calY = c.getUTCFullYear(); calM = c.getUTCMonth();
  renderCal(); calBox.style.display = 'block';
};
document.addEventListener('click', (e) => { if (!calBox.contains(e.target)) calBox.style.display = 'none'; });
$('play').onclick = () => {
  playing = !playing;
  $('play').textContent = playing ? 'Pause' : 'Play';
};
$('grat').onchange = (e) => { graticule.visible = e.target.checked; };

// Zoom: each wheel notch changes the HEIGHT above the focus body by a fixed percentage, so it feels the same from far
// away down to the ground. In free-fly mode the wheel moves the camera forward and back instead.
const MIN_ALT = { earth: 0.05, sun: 2 };
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  flight = null;
  if (view.free) { camera.translateZ(Math.sign(e.deltaY) * nearestAlt() * 0.25); return; }
  const f = view.focus;
  const rb = bodyRadiusNow(f);
  const t = bodyW(f);
  const dir = camera.position.clone().sub(t);
  const alt = dir.length() - rb;
  const lo = f === 'moon' ? (pole.ready ? pole.minAltitude() : poleGray.ready ? poleGray.minAltitude() : 0.01) : MIN_ALT[f];
  const hi = view.mode === 'moon' ? 79 : 1e6;
  const next = THREE.MathUtils.clamp(alt * Math.exp(e.deltaY * 0.0012), lo + (f === 'moon' ? Math.max(0, groundLift(camera.position)) : 0), hi);
  camera.position.copy(t).add(dir.normalize().multiplyScalar(rb + next));
}, { passive: false });

// Terrain heatmap (south pole): off = Moon photo, on = colours by height, sharp at every zoom level
const pole = new PoleHeat(moon, camera, renderer, 'pole_tiles/');
const surfOpt = (v) => $('surface').querySelector(`option[value="${v}"]`);
pole.init().then(() => { surfOpt('heat').disabled = false; }).catch(() => {
  $('heatNote').textContent = 'Height tiles not found: run scripts/15_make_heat_tiles.py and copy public/pole_tiles next to index.html.';
});
const poleGray = new PoleHeat(moon, camera, renderer, 'pole_tiles_gray/');   // same heights in Moon-like grey
poleGray.init().then(() => { surfOpt('gray').disabled = false; }).catch(() => { /* optional: python scripts/15_make_heat_tiles.py --gray */ });
function setSurface(v) {
  $('surface').value = v;
  pole.setVisible(v === 'heat');
  poleGray.setVisible(v === 'gray');
  const layer = v === 'heat' ? pole : v === 'gray' ? poleGray : null;
  moonHole.value = layer && layer.reliefOn ? 1 : 0;
  $('legend').style.display = layer ? 'block' : 'none';
  if (!layer) return;
  const m = layer.info;
  $('legBar').style.background = m.css;
  $('legLo').textContent = `${(m.lo_m / 1000).toFixed(1)} km`;
  $('legHi').textContent = `+${(m.hi_m / 1000).toFixed(1)} km`;
  $('legNote').textContent = v === 'heat' ? 'Blue = low ground, red = high. Zoom in: the picture stays sharp.'
    : 'Dark grey = low ground, light grey = high, with shadows like the real Moon. Zoom in: the picture stays sharp.';
}
$('surface').onchange = (e) => setSurface(e.target.value);
// 3D relief: 0 = flat, 1 = the true height, 3 = three times taller (easier to see from far away)
function setRelief(x) {
  $('relief').value = String(x);
  pole.setRelief(x); poleGray.setRelief(x);
  setSurface($('surface').value);
}
$('relief').onchange = (e) => setRelief(Number(e.target.value));

// Best landing site: pick a date, see the sites ranked (numbers precomputed by scripts/18_rank_sites.py).
ranking = initRanking({
  $, sites, T0_MS, MS_H,
  getHour: () => hour,
  getSelected: () => selected,
  // turn the Moon to that time at once, so the 3D view shows the date that was ranked
  setHour: (h, now = false) => { hour = h; slider.value = String(h); if (now) { setHour(h); moon.updateMatrixWorld(true); } },
  openCard: (i) => select(i),
});

// ---------------------------------------------------------------------------
// Game controller (Xbox or any standard gamepad): fly freely with the sticks.
//   left stick  = move forward / back / sideways        right stick = look around
//   RT / LT     = go up / down                          RB / LB     = roll
//   A (hold)    = fast                                  B (hold)    = slow
//   Y           = play / pause time                     X           = lock to the site / unlock
// The browser only shows a controller after you press a button on it once.
// ---------------------------------------------------------------------------
const PAD_DEAD = 0.15;              // ignore tiny stick movements (sticks never rest exactly at zero)
const PAD_LOOK = 1.6;               // radians per second at full stick
const padPrev = {};                 // which buttons were down last frame (to react once per press)
const stick = (v) => (Math.abs(v) < PAD_DEAD ? 0 : (v - Math.sign(v) * PAD_DEAD) / (1 - PAD_DEAD));
const padNote = (t) => { $('padNote').textContent = t; $('padNote').style.display = t ? 'block' : 'none'; };
window.addEventListener('gamepadconnected', (e) => padNote(`Controller connected: ${e.gamepad.id.split('(')[0].trim()}. Left stick = move, right stick = look, RT/LT = up/down, RB/LB = roll, A = fast, B = slow, Y = play/pause, X = lock to site.`));
window.addEventListener('gamepaddisconnected', () => padNote(''));
function pollGamepad(dt) {
  const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected && p.mapping === 'standard')
    || [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected);
  if (!pad) return;
  const btn = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
  const once = (i) => { const d = btn(i) > 0.5; const hit = d && !padPrev[i]; padPrev[i] = d; return hit; };
  if (once(3)) $('play').onclick();                       // Y: play / pause
  if (once(2) && view.free) setLock(!locked);             // X: lock to the site
  const mx = stick(pad.axes[0] || 0); const mz = stick(pad.axes[1] || 0);
  const lx = stick(pad.axes[2] || 0); const ly = stick(pad.axes[3] || 0);
  const upDown = btn(7) - btn(6); const roll = btn(4) - btn(5);
  if (!mx && !mz && !lx && !ly && !upDown && !roll) return;
  if (!view.free) setFree(true);                          // touching the sticks switches to free fly
  const speed = fly.movementSpeed * (btn(0) > 0.5 ? 4 : 1) * (btn(1) > 0.5 ? 0.25 : 1) * dt;   // slower near the ground, like the keyboard
  camera.translateX(mx * speed); camera.translateZ(mz * speed); camera.translateY(upDown * speed);
  camera.rotateY(-lx * PAD_LOOK * dt); camera.rotateX(-ly * PAD_LOOK * dt); camera.rotateZ(roll * 0.9 * dt);
}

const timer = new THREE.Timer();
timer.connect(document); // freezes the delta while the tab is hidden

renderer.setAnimationLoop(() => {
  timer.update();
  const dt = timer.getDelta();

  if (playing) {
    hour += Number($('speed').value) * dt;
    if (hour > N - 1) hour = 0;
    slider.value = String(hour);
  }
  const prevMoon = moon.matrixWorld.clone();
  setHour(hour);
  { const iso = isoDay(T0_MS + hour * MS_H); if (pick.textContent !== iso) pick.textContent = iso; }
  updateCard(hour, performance.now());

  moon.updateMatrixWorld(true);
  if (locked && view.free) {          // carry the camera with the Moon's surface (its spin and its travel)
    const delta = moon.matrixWorld.clone().multiply(prevMoon.invert());
    const dq = new THREE.Quaternion().setFromRotationMatrix(delta);
    camera.position.applyMatrix4(delta);
    camera.quaternion.premultiply(dq);
    camera.up.applyQuaternion(dq);
  }
  const moonW = bodyW('moon');
  // Keep markers a sensible on-screen size at any zoom; the selected one is larger
  const alt = camera.position.distanceTo(moonW) - 1;               // height above the Moon, in Moon radii
  const ms = THREE.MathUtils.clamp(alt / 8, 0.0008, 1.5);
  poleDot.scale.setScalar(ms);
  updatePins();

  // Camera: follow the focus body while it moves, or fly to a new place
  if (!view.free) {
    const tgt = bodyW(view.focus, _w);
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / flight.secs);
      const s = THREE.MathUtils.smootherstep(flight.t, 0, 1);
      const target = flight.tFrom.clone().lerp(tgt, s);
      const q = new THREE.Quaternion().setFromUnitVectors(flight.dirFrom, flight.dirTo);
      const dir = flight.dirFrom.clone().applyQuaternion(new THREE.Quaternion().slerp(q, s));
      const len = Math.exp(THREE.MathUtils.lerp(Math.log(flight.lenFrom), Math.log(flight.lenTo), s));
      camera.position.copy(target).addScaledVector(dir, len);
      controls.target.copy(target);
      if (flight.t >= 1) flight = null;
    } else {
      camera.position.add(_v1.copy(tgt).sub(controls.target));
      controls.target.copy(tgt);
    }
  }

  // Camera rules near any body: rotate and move slower close to the ground, keep the near plane just in front of the surface
  const nAlt = nearestAlt();
  const focusAlt = Math.max(camera.position.distanceTo(controls.target) - bodyRadiusNow(view.focus), 1e-4);
  controls.rotateSpeed = THREE.MathUtils.clamp(focusAlt / bodyRadiusNow(view.focus), 0.01, 1);
  camera.near = Math.max(1e-5, nAlt * 0.2);
  camera.updateProjectionMatrix();
  fly.movementSpeed = nAlt * 1.2;

  ranking.update();
  pollGamepad(dt);
  if (view.free) fly.update(dt); else controls.update(dt);
  { // close limit: the camera never goes lower than about 150 m above the Moon's real ground
    const mc = bodyW('moon', _w); const d = camera.position.distanceTo(mc);
    const floor = 1 + Math.max(0, groundLift(camera.position)) + 0.00009;
    if (d < floor && d > 1e-9) camera.position.sub(mc).multiplyScalar(floor / d).add(mc);
  }
  camera.updateMatrixWorld();

  // name tags follow their body; hidden when the camera is already very close to it
  if (view.mode !== 'moon') {
    for (const k of ['moon', 'earth', 'sun']) {
      const p = bodyW(k, _w);
      labels[k].position.copy(root.worldToLocal(p.clone()));
      dots[k].position.copy(labels[k].position);
      const dd = camera.position.distanceTo(p);
      labels[k].visible = dd > BODY_R[k] * 8;
      dots[k].visible = dd > BODY_R[k] * 40;      // only while the body is too small to see by itself
    }
  }
  // lines are drawn around the body they belong to
  moonTrail.position.copy(earthP);
  earthTrail.position.copy(sunP);
  skyDome.position.copy(camera.position);
  sunMat.uniforms.uTime.value = performance.now() / 1000;
  pole.update();
  poleGray.update();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Handy for debugging in the browser console
window.__polar = { select, sites, evalSite, camera, controls, pole, view, setView, flyTo, bodyW, fly, setHeat: (v) => setSurface(v ? 'heat' : 'photo'), setSurface, setRelief, poleGray, ranking, groundRadiusAt,
  screenOf: (i) => { const v = sites[i].marker.getWorldPosition(new THREE.Vector3()).project(camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight }; }, setHourDebug: (h) => { hour = h; slider.value = String(h); } };