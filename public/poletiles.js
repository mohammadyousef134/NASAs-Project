// poletiles.js  -  the south-pole height heatmap, drawn as zoomable tiles on the Moon.
//
// IDEA (same as Google Earth): the pole picture is cut into tiles by script 15 (a pyramid: level 0 = 1 blurry tile for
// the whole area, level 1 = 4 tiles, level 2 = 16 tiles ...). Each frame we look at where the camera is:
//   - far away  -> draw a few big low-detail tiles
//   - close up  -> replace each tile by its 4 sharper children, but only for the part of the Moon you are looking at.
// A tile is replaced by its children only when all 4 have finished loading, so you never see holes.
// The rule "split a tile when one of its pixels is bigger than one screen pixel" keeps the picture sharp at every zoom.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const SEG = 32;                    // each tile is a 32 x 32 grid of quads bent onto the sphere (one height per corner)
const RADIUS = 1.00002;            // just above the Moon sphere (about 35 m) so the tiles are never hidden by it
const MAX_LOADS = 8;               // tile downloads at the same time
const MAX_TILES = 500;             // tiles kept in memory; the least recently used are thrown away
const KEEP_FRAMES = 600;           // a tile is only thrown away after it was not needed for this many frames (about 10 s)
const MARGIN = 0.6;                // a tile that turned sharp stays sharp until the camera is clearly farther away (no flip-flop)
const DETAIL = 1.0;                // 1 = a tile pixel may be as big as a screen pixel before we split. Lower = sharper but heavier.
const CUT_Z = -Math.cos(10 * DEG); // sin(latitude) of 80 S: only draw south of 80 S (the area the tiles cover)
const EDGE = 10 * DEG;             // angle from the pole where the tiles end
const FADE = 1 * DEG;              // over the last 1 degree the relief sinks back to the smooth Moon, so there is no step at the rim
const SKIRT = 0.04;                // each tile has a small wall hanging down around it; it hides gaps between sharp and blurry tiles

// Same latitude cut-off on the GPU, so the square tile area is shown as a clean circle
function patch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vZ;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZ = position.z / length(position);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vZ;')
    .replace('void main() {', `void main() {\n  if (vZ > ${CUT_Z.toFixed(6)}) discard;`);
}

export class PoleHeat {
  constructor(parent, camera, renderer, baseUrl = 'pole_tiles/') {
    this.parent = parent;          // the Moon group: tiles are placed in Moon-fixed coordinates
    this.camera = camera;
    this.renderer = renderer;
    this.baseUrl = baseUrl;
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);
    this.loader = new THREE.TextureLoader();
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.nodes = new Map();
    this.queue = [];
    this.inflight = 0;
    this.loaded = 0;
    this.frame = 0;
    this.drawn = [];
    this.ready = false;
    this.info = null;
    this.exag = 1;                 // relief: 0 = flat, 1 = true height, 3 = three times taller
    this.hasRelief = false;        // true when script 15 saved the heights next to the pictures
    this.frustum = new THREE.Frustum();
    this.pv = new THREE.Matrix4();
    this.sphere = new THREE.Sphere();
    this.tmpC = new THREE.Vector3();
    this.tmpN = new THREE.Vector3();
    this.size2 = new THREE.Vector2();
    this.moonW = new THREE.Vector3();
    this.camRel = new THREE.Vector3();
    this.camHat = new THREE.Vector3();
    // geometry parts shared by all tiles
    const n = SEG + 1;
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      // aim at pixel centres so neighbouring tiles join without a seam
      uv[(j * n + i) * 2] = (0.5 + (i / SEG) * 511) / 512;
      uv[(j * n + i) * 2 + 1] = 1 - (0.5 + (j / SEG) * 511) / 512;
    }
    const idx = [];
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      const a = j * n + i; const b = a + 1; const c = a + n; const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // the skirt: the vertices on the 4 edges are copied once more (they are pushed down in ensureMesh)
    this.edge = [];
    for (let i = 0; i < n; i++) this.edge.push(i);                          // top
    for (let j = 1; j < n; j++) this.edge.push(j * n + SEG);                // right
    for (let i = SEG - 1; i >= 0; i--) this.edge.push(SEG * n + i);         // bottom
    for (let j = SEG - 1; j >= 1; j--) this.edge.push(j * n);               // left
    const uvAll = new Float32Array((n * n + this.edge.length) * 2);
    uvAll.set(uv);
    this.edge.forEach((v, k) => { uvAll[(n * n + k) * 2] = uv[v * 2]; uvAll[(n * n + k) * 2 + 1] = uv[v * 2 + 1]; });
    for (let k = 0; k < this.edge.length; k++) {
      const k2 = (k + 1) % this.edge.length;
      idx.push(this.edge[k], n * n + k, this.edge[k2], this.edge[k2], n * n + k, n * n + k2);
    }
    this.uvAttr = new THREE.BufferAttribute(uvAll, 2);
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1);
  }

  async init() {
    const r = await fetch(this.baseUrl + 'manifest.json');
    if (!r.ok) throw new Error('pole_tiles/manifest.json not found');
    this.info = await r.json();
    const m = this.info;
    this.half = m.half_width_m; this.tilePx = m.tile_px; this.maxLevel = m.max_level;
    this.ext = m.ext; this.discR = m.disc_radius_m; this.R = m.moon_radius_m;
    this.hasRelief = m.relief_seg === SEG;
    this.hMin = m.h_min_m ?? m.lo_m; this.hMax = m.h_max_m ?? m.hi_m;
    this.root = this.node(0, 0, 0, null);
    await new Promise((res, rej) => this.load(this.root, res, rej));
    this.ready = true;
  }

  // ---- relief (real 3D ground) ----
  setRelief(exag) {                // 0 = flat, 1 = true height, more = taller
    this.exag = exag;
    for (const nd of this.nodes.values()) if (nd.mesh) { this.group.remove(nd.mesh); nd.mesh.geometry.dispose(); nd.mesh.material.dispose(); nd.mesh = null; }
    this.drawn = [];
  }

  get reliefOn() { return this.hasRelief && this.exag > 0; }

  // how far a height (metres) lifts the ground, in Moon radii. c = angle from the south pole
  lift(h, c) {
    const t = Math.min(1, Math.max(0, (EDGE - c) / FADE));
    return (h * this.exag / this.R) * t * t * (3 - 2 * t);
  }

  // ground lift (Moon radii) under a direction given in Moon-fixed axes; uses the sharpest tile already loaded
  liftAt(dir) {
    if (!this.ready || !this.reliefOn) return 0;
    const len = dir.length();
    const c = Math.acos(Math.min(1, Math.max(-1, -dir.z / len)));
    if (c >= EDGE) return 0;
    const lon = Math.atan2(dir.y, dir.x); const rho = 2 * this.R * Math.tan(c / 2);
    const x = rho * Math.sin(lon); const y = rho * Math.cos(lon);
    let nd = this.root;
    for (; ;) {
      const s = nd.size / 2;
      const kid = this.nodes.get(`${nd.z + 1}/${nd.x * 2 + (x >= nd.x0 + s ? 1 : 0)}/${nd.y * 2 + (y <= nd.y1 - s ? 1 : 0)}`);
      if (!kid || kid.state !== 3 || !kid.h) break;
      nd = kid;
    }
    if (!nd.h) return 0;
    const n = SEG + 1;
    const fx = Math.min(SEG - 1e-6, Math.max(0, ((x - nd.x0) / nd.size) * SEG)); const fy = Math.min(SEG - 1e-6, Math.max(0, ((nd.y1 - y) / nd.size) * SEG));
    const i = Math.floor(fx); const j = Math.floor(fy); const u = fx - i; const v = fy - j;
    const h = nd.h[j * n + i] * (1 - u) * (1 - v) + nd.h[j * n + i + 1] * u * (1 - v) + nd.h[(j + 1) * n + i] * (1 - u) * v + nd.h[(j + 1) * n + i + 1] * u * v;
    return this.lift(h, c);
  }

  setVisible(v) {
    this.group.visible = v;
    if (!v) for (const nd of this.drawn) nd.mesh.visible = false;
    if (!v) this.drawn = [];
  }

  // ---- tiles ----
  node(z, x, y, parent) {
    const key = `${z}/${x}/${y}`;
    let nd = this.nodes.get(key);
    if (nd) return nd;
    const size = (2 * this.half) / 2 ** z;
    const x0 = -this.half + x * size;
    const y1 = this.half - y * size;
    nd = { key, z, x, y, parent, size, x0, y1, state: 0, tex: null, h: null, mesh: null, last: 0, req: 0 };
    // centre direction (unit vector in Moon-fixed frame) and bounding radius (in Moon radii)
    nd.centre = this.stereoToVec(x0 + size / 2, y1 - size / 2, new THREE.Vector3());
    nd.radius = (size * Math.SQRT1_2) / this.R * 1.1 + 1e-5 + 0.03;   // + room for the relief
    this.nodes.set(key, nd);
    return nd;
  }

  exists(z, x, y) { // false when the tile lies completely outside the 80 S disc (script 15 does not make those)
    const size = (2 * this.half) / 2 ** z;
    const x0 = -this.half + x * size;
    const y1 = this.half - y * size;
    const dx = x0 > 0 ? x0 : (x0 + size < 0 ? -(x0 + size) : 0);
    const dy = y1 - size > 0 ? y1 - size : (y1 < 0 ? -y1 : 0);
    return Math.hypot(dx, dy) <= this.discR;
  }

  children(nd) {
    const out = [];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = nd.x * 2 + dx; const y = nd.y * 2 + dy;
      if (this.exists(nd.z + 1, x, y)) out.push(this.node(nd.z + 1, x, y, nd));
    }
    return out;
  }

  // polar stereographic map position (metres from the pole; +y = longitude 0, +x = longitude 90 E) -> unit vector
  stereoToVec(x, y, out) {
    const c = 2 * Math.atan(Math.hypot(x, y) / (2 * this.R)); // angle from the south pole
    const lon = Math.atan2(x, y);
    const cl = Math.sin(c);
    return out.set(cl * Math.cos(lon), cl * Math.sin(lon), -Math.cos(c));
  }

  request(nd) {
    nd.req = this.frame;
    if (nd.state === 0) { nd.state = 1; this.queue.push(nd); }
  }

  load(nd, onOk, onFail) {
    nd.state = 2; this.inflight++;
    const url = `${this.baseUrl}${nd.z}/${nd.x}/${nd.y}.${this.ext}`;
    // the heights of the tile corners (int16 metres), saved by script 15 next to the picture. Missing = flat tile.
    const heights = this.hasRelief
      ? fetch(`${this.baseUrl}${nd.z}/${nd.x}/${nd.y}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Int16Array(b) : null)).catch(() => null)
      : Promise.resolve(null);
    this.loader.load(url, async (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.maxAniso;
      const h = await heights;
      nd.h = h && h.length === (SEG + 1) * (SEG + 1) ? h : null;
      nd.tex = tex; nd.state = 3; this.inflight--; this.loaded++;
      onOk && onOk();
    }, undefined, () => {
      nd.state = -1; this.inflight--; // missing tile: the parent stays on screen
      onFail && onFail(new Error('tile failed: ' + url));
    });
  }

  pump() {
    while (this.inflight < MAX_LOADS && this.queue.length) {
      const nd = this.queue.pop();               // newest request first (it is the most relevant to the current view)
      if (nd.state !== 1) continue;
      if (this.frame - nd.req > 20) { nd.state = 0; continue; } // nobody wants it any more
      this.load(nd);
    }
  }

  ensureMesh(nd) {
    if (nd.mesh) return nd.mesh;
    const n = SEG + 1;
    const p = new Float32Array((n * n + this.edge.length) * 3);
    const v = new THREE.Vector3();
    const relief = this.reliefOn && nd.h;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = nd.x0 + (nd.size * i) / SEG; const y = nd.y1 - (nd.size * j) / SEG;
      const up = relief ? this.lift(nd.h[j * n + i], 2 * Math.atan(Math.hypot(x, y) / (2 * this.R))) : 0;
      this.stereoToVec(x, y, v).multiplyScalar(RADIUS + up);
      p.set([v.x, v.y, v.z], (j * n + i) * 3);
    }
    const drop = relief ? 1 - (SKIRT * nd.size) / this.R : 1;   // skirt: the same edge points, a bit lower
    this.edge.forEach((e, k) => p.set([p[e * 3] * drop, p[e * 3 + 1] * drop, p[e * 3 + 2] * drop], (n * n + k) * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', this.uvAttr);
    g.setIndex(this.index);
    const mat = new THREE.MeshBasicMaterial({ map: nd.tex, side: THREE.DoubleSide });
    mat.onBeforeCompile = patch;
    mat.customProgramCacheKey = () => 'poleheat';
    nd.mesh = new THREE.Mesh(g, mat);
    nd.mesh.frustumCulled = false;
    this.group.add(nd.mesh);
    return nd.mesh;
  }

  evict() {
    if (this.loaded <= MAX_TILES) return;
    const cand = [...this.nodes.values()].filter((nd) => nd.state === 3 && nd.z >= 2 && nd.last < this.frame - KEEP_FRAMES)
      .sort((a, b) => a.last - b.last);
    for (const nd of cand) {
      if (this.loaded <= MAX_TILES) break;
      if (nd.mesh) { this.group.remove(nd.mesh); nd.mesh.geometry.dispose(); nd.mesh.material.dispose(); nd.mesh = null; }
      nd.tex.dispose(); nd.tex = null; nd.h = null; nd.state = 0; this.loaded--;
    }
  }

  // ---- called every frame ----
  update() {
    if (!this.ready || !this.group.visible) return;
    this.frame++;
    const cam = this.camera;
    this.parent.updateWorldMatrix(true, false);
    this.mw = this.parent.matrixWorld;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    this.moonW.setFromMatrixPosition(this.mw);                   // where the Moon is (it moves in the true-scale views)
    this.camRel.copy(cam.position).sub(this.moonW);
    this.camDist = this.camRel.length();                        // camera distance from the Moon's centre
    this.camHat.copy(this.camRel).normalize();
    const h = this.renderer.getDrawingBufferSize(this.size2).y;  // pixels tall
    this.pixelK = (2 * Math.tan((cam.fov * DEG) / 2)) / h;      // world size of one screen pixel = distance * pixelK
    for (const nd of this.drawn) nd.mesh.visible = false;
    this.drawn = [];
    this.visit(this.root);
    this.pump();
    if (this.frame % 30 === 0) this.evict();
  }

  visit(nd) {
    const c = this.tmpC.copy(nd.centre).multiplyScalar(RADIUS).applyMatrix4(this.mw);
    const rad = nd.radius;
    // 1. outside the view?
    this.sphere.set(c, rad);
    if (!this.frustum.intersectsSphere(this.sphere)) return;
    // 2. on the far side of the Moon?
    const n = this.tmpN.copy(c).sub(this.moonW).normalize();
    const ang = Math.acos(Math.min(1, Math.max(-1, n.dot(this.camHat))));
    // how far round the Moon the camera can see: to its horizon, plus mountains that stick up behind it
    const rLow = this.reliefOn ? 1 + (Math.min(0, this.hMin) * this.exag) / this.R : 1;
    const rHigh = this.reliefOn ? 1 + (Math.max(0, this.hMax) * this.exag) / this.R : 1;
    const lim = Math.acos(Math.min(1, rLow / this.camDist)) + Math.acos(rLow / rHigh) + rad * 1.05;
    if (ang > lim) return;
    // 3. is a tile pixel bigger than a screen pixel? then use the 4 children (when they are ready)
    const dist = Math.max(this.camera.position.distanceTo(c) - rad, this.camDist - 1, 1e-6);
    const texel = nd.size / this.tilePx / this.R;               // size of one tile pixel in Moon radii
    const screenPx = dist * this.pixelK;
    const want = texel > screenPx * DETAIL * (nd.split ? MARGIN : 1);
    if (!want) nd.split = false;
    if (nd.z < this.maxLevel && want) {
      const kids = this.children(nd);
      let ready = kids.length > 0;
      for (const k of kids) { this.request(k); if (k.state !== 3) ready = false; }
      // all 4 children are needed together, also the ones that are off screen right now: keep them all in memory,
      // otherwise one is thrown away, the blurry parent comes back, the child reloads ... and the ground flickers
      if (ready) { nd.split = true; nd.last = this.frame; for (const k of kids) k.last = this.frame; for (const k of kids) this.visit(k); return; }
    }
    // 4. draw this tile
    const mesh = this.ensureMesh(nd);
    mesh.visible = true;
    for (let p = nd; p; p = p.parent) p.last = this.frame;      // keep it and its ancestors in memory
    this.drawn.push(nd);
  }

  // smallest useful camera height: below it the picture would only be magnified, not sharper
  minAltitude() {
    const texel = (2 * this.half) / 2 ** this.maxLevel / this.tilePx / this.R;
    const k = (2 * Math.tan((this.camera.fov * DEG) / 2)) / this.renderer.domElement.height;
    return Math.max(0.002, texel / (2 * k * (this.renderer.getPixelRatio() || 1)));
  }

  stats() {
    const levels = {};
    for (const nd of this.drawn) levels[nd.z] = (levels[nd.z] || 0) + 1;
    return { drawn: this.drawn.length, loaded: this.loaded, inflight: this.inflight, levels };
  }
}