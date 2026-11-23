import * as THREE from "three";
import { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } from "@sparkjsdev/spark";

/* ------------------------------------------------------------------ *
 *  Setup
 * ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);
const AUTHOR = params.has("author");
let preview = false; // author page: showing the visitor view
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const STORE_KEY = "china26-path-v2";

async function fetchJSON(url, fallback) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

const cfg = await fetchJSON("./config.json", {});
const SPLAT_URL = params.get("splat") || cfg.splat || "scene.sog";
$("title").textContent = cfg.title || "";
document.title = cfg.title || "Fly-through";

// Candidate orientations (degrees, XYZ euler). Splats trained from COLMAP-style
// data usually come out upside-down; press O in author mode to cycle.
const ORIENTATIONS = [
  [0, 0, 0],
  [180, 0, 0],
  [90, 0, 0],
  [-90, 0, 0],
  [0, 0, 180],
  [0, 180, 0],
].map(([x, y, z]) =>
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), "XYZ")
  )
);

/* ------------------------------------------------------------------ *
 *  Path data  { orientation, duration, waypoints:[{p:[x,y,z], q:[x,y,z,w]}] }
 * ------------------------------------------------------------------ */
let pathData = null;
// path.json is the source of truth. In author mode, edits are also kept as a draft in this browser so a refresh doesn't lose them,
// but a draft is only used while it still builds on the current path.json; replace path.json and the stale draft is dropped.
const fileJSON = await fetchJSON("./path.json", null);
const fileSig = fileJSON ? JSON.stringify(fileJSON) : "";
if (AUTHOR) {
  try {
    if (localStorage.getItem(STORE_KEY + ":base") === fileSig) pathData = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {}
}
if (!pathData) pathData = fileJSON;
if (!pathData) pathData = { orientation: cfg.orientation ?? 3, duration: cfg.duration ?? 90, waypoints: [] };
pathData.waypoints ??= [];
pathData.duration ??= cfg.duration ?? 90;
pathData.orientation ??= cfg.orientation ?? 3;

// undo / redo history (author mode): snapshots of the path after every change
const hist = { stack: [], i: -1 };
const snap = () => JSON.stringify({ o: pathData.orientation, w: pathData.waypoints, d: pathData.duration });
function record() {
  const s = snap();
  if (hist.stack[hist.i] === s) return;
  hist.stack.length = hist.i + 1;
  hist.stack.push(s);
  if (hist.stack.length > 200) hist.stack.shift();
  hist.i = hist.stack.length - 1;
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pathData));
    localStorage.setItem(STORE_KEY + ":base", fileSig);
  } catch {}
}
function save() {
  if (!AUTHOR) return;
  record();
  persist();
}
function stepHistory(dir) {
  const j = hist.i + dir;
  if (j < 0 || j >= hist.stack.length) return hudFlash(dir < 0 ? "Nothing to undo" : "Nothing to redo");
  hist.i = j;
  const st = JSON.parse(hist.stack[j]);
  const orientChanged = st.o !== pathData.orientation;
  pathData.orientation = st.o;
  pathData.waypoints = st.w;
  if (st.d) pathData.duration = st.d;
  if (orientChanged) mesh.quaternion.copy(ORIENTATIONS[st.o]);
  selected = Math.min(selected, st.w.length - 1);
  persist();
  rebuildPath();
  if (orientChanged) buildFloor();
  if (!curve && mode === "tour") setMode("free");
  hudFlash((dir < 0 ? "Undo" : "Redo") + " · " + st.w.length + " point" + (st.w.length === 1 ? "" : "s"));
}
if (AUTHOR) record();

/* ------------------------------------------------------------------ *
 *  Three + Spark
 * ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
scene.add(camera);
const spark = new SparkRenderer({
  renderer,
  ...(cfg.lodSplatCount ? { lodSplatCount: cfg.lodSplatCount } : {}),
});
scene.add(spark);

/* Remember the splat on the visitor's device. A small service worker (sw.js) keeps the big file in the browser's Cache
   Storage after the first download, so later visits load it from the device instead of the network. Only on https
   (service workers need it) and never in author mode, where the file changes while you work. Add ?nocache to skip it. */
async function enableSplatCache() {
  if (AUTHOR || params.has("nocache") || !("serviceWorker" in navigator) || location.protocol !== "https:") return;
  try {
    await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // first visit: give the worker a moment to take over this page so the download below goes through it
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
    navigator.storage?.persist?.();
  } catch (e) {
    console.warn("splat cache unavailable", e);
  }
}
// never let the saving step hold up the page: if it is not ready within 4 seconds, load the splat the normal way
await Promise.race([enableSplatCache(), new Promise((r) => setTimeout(r, 4000))]);

const mesh = new SplatMesh({
  url: SPLAT_URL,
  lod: params.has("nolod") ? false : cfg.lod ?? false,
  onProgress: (e) => {
    if (e && e.total) {
      const p = Math.round((e.loaded / e.total) * 100);
      $("pct").textContent = p + "%";
      $("bar").style.width = p + "%";
    } else if (e && e.loaded) {
      $("pct").textContent = (e.loaded / 1048576).toFixed(0) + " MB";
    }
  },
});
mesh.quaternion.copy(ORIENTATIONS[pathData.orientation] ?? ORIENTATIONS[0]);
scene.add(mesh);

try {
  await mesh.initialized;
} catch (err) {
  $("pct").textContent = "Couldn't load " + SPLAT_URL;
  console.error(err);
  throw err;
}

/* Scene scale: robust (percentile) bounds so stray floaters don't skew it. */
let diag = 10;
let center = new THREE.Vector3();
try {
  const xs = [], ys = [], zs = [];
  const stride = Math.max(1, Math.floor(mesh.numSplats / 60000));
  mesh.forEachSplat((i, c, s, q, o) => {
    if (i % stride === 0 && o > 0.3) {
      xs.push(c.x);
      ys.push(c.y);
      zs.push(c.z);
    }
  });
  const pct = (a, f) => {
    a.sort((p, q) => p - q);
    return a[Math.floor(f * (a.length - 1))];
  };
  const lo = new THREE.Vector3(pct(xs, 0.05), pct(ys, 0.05), pct(zs, 0.05));
  const hi = new THREE.Vector3(pct(xs, 0.95), pct(ys, 0.95), pct(zs, 0.95));
  const mid = new THREE.Vector3(pct(xs, 0.5), pct(ys, 0.5), pct(zs, 0.5));
  diag = hi.sub(lo).length() || 10;
  center = mid.applyQuaternion(mesh.quaternion);
} catch (e) {
  console.warn("bounds failed", e);
}
camera.near = Math.max(diag * 0.0003, 0.001);
camera.far = diag * 20;
camera.updateProjectionMatrix();

/* ------------------------------------------------------------------ *
 *  Ground: heightfield built from the splats so you can't fly under the floor
 * ------------------------------------------------------------------ */
const GROUND = { on: true };
let floorGrid = null;
let clearance = 0.3;

function buildFloor() {
  try {
    const stride = Math.max(1, Math.floor(mesh.numSplats / 250000));
    const cs = Math.max(diag * 0.012, 0.05);
    clearance = Math.max(diag * 0.02, 0.15);
    const cells = new Map();
    const v = new THREE.Vector3();
    mesh.forEachSplat((i, c, s, q, o) => {
      if (i % stride !== 0 || o < 0.3) return;
      v.copy(c).applyQuaternion(mesh.quaternion);
      const key = Math.floor(v.x / cs) + "," + Math.floor(v.z / cs);
      let a = cells.get(key);
      if (!a) cells.set(key, (a = []));
      a.push(v.y);
    });
    // per-cell floor = low percentile of heights; ignore sparse cells (floaters)
    let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    const floors = new Map();
    for (const [key, a] of cells) {
      if (a.length < 6) continue;
      a.sort((p, q) => p - q);
      const [ix, iz] = key.split(",").map(Number);
      floors.set(key, a[Math.floor(0.12 * (a.length - 1))]);
      i0 = Math.min(i0, ix); i1 = Math.max(i1, ix);
      j0 = Math.min(j0, iz); j1 = Math.max(j1, iz);
    }
    if (!floors.size) return;
    const w = Math.min(i1 - i0 + 1, 1500), h = Math.min(j1 - j0 + 1, 1500);
    const vals = [...floors.values()].sort((p, q) => p - q);
    const globalFloor = vals[Math.floor(0.2 * (vals.length - 1))];
    const data = new Float32Array(w * h).fill(NaN);
    for (const [key, f] of floors) {
      const [ix, iz] = key.split(",").map(Number);
      const x = ix - i0, z = iz - j0;
      if (x >= 0 && x < w && z >= 0 && z < h) data[z * w + x] = f;
    }
    // fill holes from nearby cells, else the global floor
    const filled = new Float32Array(data);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        if (!Number.isNaN(data[z * w + x])) continue;
        let sum = 0, cnt = 0;
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
            const f = data[zz * w + xx];
            if (!Number.isNaN(f)) { sum += f; cnt++; }
          }
        }
        filled[z * w + x] = cnt ? sum / cnt : globalFloor;
      }
    }
    // light smoothing so the camera glides over bumps
    const smooth = new Float32Array(filled.length);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
            sum += filled[zz * w + xx]; cnt++;
          }
        }
        smooth[z * w + x] = sum / cnt;
      }
    }
    floorGrid = { cs, i0, j0, w, h, data: smooth, globalFloor };
  } catch (e) {
    console.warn("floor build failed", e);
    floorGrid = null;
  }
}

function floorAt(x, z) {
  const g = floorGrid;
  if (!g) return -Infinity;
  const fx = x / g.cs - g.i0 - 0.5, fz = z / g.cs - g.j0 - 0.5;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const at = (i, j) => (i < 0 || j < 0 || i >= g.w || j >= g.h ? g.globalFloor : g.data[j * g.w + i]);
  const a = at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx;
  const b = at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx;
  return a * (1 - tz) + b * tz;
}

buildFloor();

/* ------------------------------------------------------------------ *
 *  Camera state
 * ------------------------------------------------------------------ */
let mode = "free"; // "free" | "tour"
let yaw = 0,
  pitch = 0;
const euler = new THREE.Euler(0, 0, 0, "YXZ");
let speedMul = 1;
const baseSpeed = () => diag / 26; // units per second (default free-fly speed; scroll adjusts it)
const keys = new Set();
const vel = new THREE.Vector3();

function setCameraFromYawPitch() {
  euler.set(pitch, yaw, 0, "YXZ");
  camera.quaternion.setFromEuler(euler);
}
function syncYawPitchFromCamera() {
  euler.setFromQuaternion(camera.quaternion, "YXZ");
  yaw = euler.y;
  pitch = euler.x;
}

/* ------------------------------------------------------------------ *
 *  Path sampling
 * ------------------------------------------------------------------ */
let curve = null;
let wpU = []; // arc-length parameter of each waypoint (where it sits on the route)
let wpT = []; // timeline position of each waypoint, 0..1 (auto = wpU, or a custom w.t you dragged)
// timeline position -> position along the route (piecewise between waypoints, so each point lands on its own time)
let wpM = [], wpMI = [], wpIO = [], wpII = [], segB = []; // per point: speed leaving / arriving (route fraction per timeline fraction), influence leaving / arriving; per stretch: bezier control points
function buildTimeMap() {
  const n = wpT.length;
  wpM = []; wpMI = []; wpIO = []; wpII = []; segB = [];
  if (n < 2) return;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((wpU[i + 1] - wpU[i]) / Math.max(wpT[i + 1] - wpT[i], 1e-6));
  wpM = new Array(n);
  wpM[0] = d[0];
  wpM[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) wpM[i] = d[i - 1] * d[i] > 0 ? (d[i - 1] + d[i]) / 2 : 0;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { wpM[i] = wpM[i + 1] = 0; continue; }
    const a = wpM[i] / d[i], b = wpM[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); wpM[i] = k * a * d[i]; wpM[i + 1] = k * b * d[i]; }
  }
  wpMI = wpM.slice();
  // what you set in the speed graph (like After Effects keyframes): v = speed at the point in m/s (vb: arriving side only),
  // io / ii = influence, how far along the neighbouring stretch the ease reaches (1/3 = the automatic smooth curve)
  const wps = pathData.waypoints, lenM = curve ? curve.getLength() : 0, durS = Math.max(pathData.duration, 1);
  wps.forEach((w, i) => {
    if (i >= n) return;
    if (lenM > 0) {
      if (w.v != null) wpM[i] = wpMI[i] = (w.v * durS) / lenM;
      if (w.vb != null) wpMI[i] = (w.vb * durS) / lenM;
    }
    wpIO[i] = clamp(w.io ?? 1 / 3, 0.02, 0.95);
    wpII[i] = clamp(w.ii ?? 1 / 3, 0.02, 0.95);
  });
  for (let j = 0; j < n - 1; j++) {
    const x0 = wpT[j], x3 = wpT[j + 1], h = x3 - x0, u0 = wpU[j], u3 = wpU[j + 1];
    let io = wpIO[j], ii = wpII[j + 1];
    if (io + ii > 0.98) { const k = 0.98 / (io + ii); io *= k; ii *= k; }
    const u1 = clamp(u0 + wpM[j] * io * h, u0, u3), u2 = clamp(u3 - wpMI[j + 1] * ii * h, u1, u3); // never runs backwards
    segB.push([x0, x0 + io * h, x3 - ii * h, x3, u0, u1, u2, u3, io, ii]);
  }
}
const bez3 = (a, b, c, d, t) => { const m = 1 - t; return m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * c + t * t * t * d; };
// timeline position -> position along the route: a cubic bezier between neighbouring points whose handles are the speed and
// influence at each point, exactly like keyframe handles in After Effects' speed graph.
function tlToU(x) {
  const n = wpT.length;
  if (n < 2 || !segB.length) return x;
  x = clamp(x, 0, 1);
  let j = 0;
  while (j < n - 2 && x > wpT[j + 1]) j++;
  const b = segB[j];
  let lo = 0, hi = 1;
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    if (bez3(b[0], b[1], b[2], b[3], mid) < x) lo = mid; else hi = mid;
  }
  return clamp(bez3(b[4], b[5], b[6], b[7], (lo + hi) / 2), 0, 1);
}
const T_GAP = 0.004;
let pathLine = null;
const overlay = new THREE.Scene(); // drawn after the splats, always on top
const markers = new THREE.Group();
overlay.add(markers);

let speedOn = false, speedDirty = true, speedLast = -1, speedDrag = null, speedHover = null, speedYMax = 0, gSel = new Set(); // gSel: points picked together in the graph
let editing = false; // author: point-editing mode (drag points, add on line)
function setEditing(on) {
  editing = !!on;
  const b = $("editBtn");
  if (b) {
    b.textContent = editing ? "✓ Done editing" : "✎ Edit path";
    b.classList.toggle("on", editing);
  }
  document.body.classList.toggle("editing", editing);
  if (editing && AUTHOR && !preview && mode === "tour") setMode("free", false, true); // points can only be moved while flying freely
  if (!editing) { selectPoint(-1); gSel.clear(); }
  hudFlash(editing ? "Edit mode · drag points to move them · double-click the line to add one" : "Edit mode off");
}
let selected = -1; // index of the selected waypoint (author mode)

function disposeGroup(g) {
  while (g.children.length) {
    const m = g.children.pop();
    m.traverse((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
    });
  }
}

function makeLabel(text, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const x = c.getContext("2d");
  x.font = "700 60px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.lineWidth = 10;
  x.strokeStyle = "rgba(0,0,0,.85)";
  x.strokeText(text, 48, 52);
  x.fillStyle = color;
  x.fillText(text, 48, 52);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 1003;
  return sp;
}

// the "look" handle at the end of a point's direction line: drag it to aim the camera at that point
function makeHandle(sel) {
  const S = 96, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  x.beginPath();
  x.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2);
  x.fillStyle = sel ? "rgba(92,200,255,.9)" : "rgba(255,255,255,.85)";
  x.fill();
  x.lineWidth = 8;
  x.strokeStyle = "#111";
  x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
}
const LOOK_LEN = () => diag * 0.06;
const _lq = new THREE.Quaternion(), _lf = new THREE.Vector3(), _lt = new THREE.Vector3();
function lookTip(i, out) {
  const w = pathData.waypoints[i];
  _lf.set(0, 0, -1).applyQuaternion(_lq.set(...w.q));
  return out.set(...w.p).addScaledVector(_lf, LOOK_LEN());
}
// nearest look handle within ~18px of the pointer
function pickLook(e) {
  let best = -1, bestD = 18;
  pathData.waypoints.forEach((w, i) => {
    const sp = toScreen(lookTip(i, _lt));
    if (!sp) return;
    const d = Math.hypot(sp[0] - e.clientX, sp[1] - e.clientY);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function makeBall(num, colorHex, sel) {
  const S = 128, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const hex = "#" + new THREE.Color(colorHex).getHexString();
  x.beginPath();
  x.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2);
  x.fillStyle = "#111";
  x.fill();
  const g = x.createRadialGradient(S * 0.38, S * 0.35, S * 0.05, S / 2, S / 2, S / 2 - 10);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.25, hex);
  g.addColorStop(1, hex);
  x.beginPath();
  x.arc(S / 2, S / 2, S / 2 - 12, 0, Math.PI * 2);
  x.fillStyle = g;
  x.fill();
  if (sel) {
    x.lineWidth = 6;
    x.strokeStyle = "#fff";
    x.stroke();
  }
  x.font = "800 " + (num > 9 ? 52 : 64) + "px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = "#111";
  x.fillText(String(num), S / 2, S / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  return sp;
}

const fmtT = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
// Jump the tour straight to a point on the timeline: no easing, no leftover look-around, so the view is the
// same one the editor shows for that point.
function snapTour(u) {
  tourTarget = tourU = u;
  lookYaw = lookPitch = 0;
  samplePathT(u, _p, _pq);
  camera.position.copy(_p);
  camera.quaternion.copy(_pq);
  $("slider").value = Math.round(u * 1000);
}
function jumpTo(i) {
  const wps = pathData.waypoints;
  if (!wps[i]) return;
  selectPoint(i);
  if (mode === "tour" && wpT[i] != null) {
    snapTour(wpT[i]);
    playing = false;
    $("playBtn").textContent = "▶";
  } else viewFrom(i);
}
// Which chapter the playhead is in: that one's dot lights up, the rest stay grey.
let chapterEls = [], nowIdx = -2;
let glide = null; // eased jump between chapters: {from,to,t,dur,last}
function updateNow(u) {
  let idx = -1;
  for (let k = 0; k < chapterEls.length; k++) if (chapterEls[k].u <= u + 0.002) idx = k;
  setNow(idx);
}
// Free roam: light up the chapter whose spot is nearest to where you are (with a little stickiness so it doesn't flicker on borders).
function updateNowFree(pos) {
  let best = -1, bd = Infinity, cur = Infinity;
  for (let k = 0; k < chapterEls.length; k++) {
    const p = chapterEls[k].p;
    if (!p) continue;
    const d = Math.hypot(pos.x - p[0], pos.y - p[1], pos.z - p[2]);
    if (k === nowIdx) cur = d;
    if (d < bd) { bd = d; best = k; }
  }
  if (best < 0) return;
  if (nowIdx >= 0 && best !== nowIdx && bd > cur * 0.85) return;
  setNow(best);
}
function setNow(idx) {
  if (idx === nowIdx) return;
  nowIdx = idx;
  chapterEls.forEach((c, k) => {
    c.row.classList.toggle("now", k === idx);
    c.mk.classList.toggle("now", k === idx);
  });
}
// Visitor view: only the points you gave a name become chapters, on the timeline and in a small menu.
function renderChapters() {
  const wps = pathData.waypoints, dur = pathData.duration;
  const named = curve ? wps.map((w, i) => ({ w, i })).filter((x) => x.w.name) : [];
  const btn = $("ptsBtn"), list = $("pts"), marks = $("marks");
  marks.innerHTML = "";
  list.innerHTML = "";
  chapterEls = [];
  nowIdx = -2;
  document.body.classList.toggle("chapters", named.length > 0);
  btn.hidden = named.length === 0;
  if (!named.length) {
    list.hidden = true;
    return;
  }
  named.forEach(({ w, i }, k) => {
    const u = wpT[i] ?? 0;
    const go = () => {
      // Exploring freely: stay in free roam. Dip to black, drop the camera at that chapter's view, fade back in.
      if (mode === "free") {
        clearTimeout(setMode.t);
        clearTimeout(go.t);
        const placeHere = () => {
          samplePathT(u, _p, _pq);
          camera.position.copy(_p);
          camera.quaternion.copy(_pq);
          vel.set(0, 0, 0);
          syncYawPitchFromCamera();
          if (chapterEls.length) updateNowFree(camera.position);
        };
        const v = $("veil");
        if (!v || matchMedia("(prefers-reduced-motion: reduce)").matches) return placeHere();
        v.style.transitionDuration = "0.22s";
        v.style.opacity = "1";
        go.t = setTimeout(() => {
          placeHere();
          v.style.transitionDuration = "0.45s";
          v.style.opacity = "0";
        }, 240);
        return;
      }
      // Dip to black, jump while the screen is dark, then fade back in: a cut would feel abrupt. (The Chapters list stays open.)
      const veil = $("veil");
      clearTimeout(go.t);
      playing = false; // picking a chapter pauses the tour at that spot
      $("playBtn").textContent = "▶";
      if (!veil || matchMedia("(prefers-reduced-motion: reduce)").matches) return snapTour(u);
      veil.style.transitionDuration = "0.22s";
      veil.style.opacity = "1";
      go.t = setTimeout(() => {
        snapTour(u);
        veil.style.transitionDuration = "0.45s";
        veil.style.opacity = "0";
      }, 240);
    };
    const mk = document.createElement("div");
    mk.className = "ch";
    mk.style.left = "calc(8px + (100% - 16px) * " + u + ")";
    mk.innerHTML = "<i></i><span></span>";
    mk.lastChild.textContent = w.name + " · " + fmtT(u * dur);
    mk.addEventListener("click", go);
    marks.appendChild(mk);
    const row = document.createElement("div");
    row.className = "pt";
    row.innerHTML = "<b>" + (k + 1) + "</b><span class=\"nm\"></span><em>" + fmtT(u * dur) + "</em>";
    row.querySelector(".nm").textContent = w.name;
    row.addEventListener("click", go);
    list.appendChild(row);
    chapterEls.push({ u, row, mk, p: w.p });
  });
}

function renderTimeline() {
  if (!AUTHOR || preview) return renderChapters();
  const wps = pathData.waypoints,
    n = wps.length,
    dur = pathData.duration;
  const marks = $("marks");
  marks.innerHTML = "";
  const list = $("pts");
  list.innerHTML = n ? "" : '<div class="empty">No points yet. Fly somewhere and press Space.</div>';
  wps.forEach((_, i) => {
    const u = wpT[i] ?? (n > 1 ? i / (n - 1) : 0);
    const cls = (i === 0 ? " first" : "") + (i === n - 1 && n > 1 ? " last" : "") + (i === selected ? " sel" : "");
    if (curve) {
      const mk = document.createElement("div");
      mk.className = "mk" + cls;
      mk.style.left = "calc(8px + (100% - 16px) * " + u + ")";
      mk.innerHTML = "<i>" + (i + 1) + "</i>" + fmtT(u * dur);
      mk.title = "Point " + (i + 1) + (wps[i].name ? " · " + wps[i].name : "") + " · " + fmtT(u * dur);
      const movable = i > 0; // the first point is pinned to 0:00; the last one sets the video length
      if (movable) {
        mk.style.cursor = "ew-resize";
        mk.title += " · drag to retime (past the end = longer video) · double-click to reset";
      }
      let dragging = false, moved = false, S0 = [], S = [], newDur = dur;
      const GAP = 0.5; // minimum seconds between points
      mk.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        moved = false;
        S0 = wpT.map((x) => x * dur);
        S = S0.slice();
        newDur = dur;
        try { mk.setPointerCapture(e.pointerId); } catch {}
      });
      mk.addEventListener("pointermove", (e) => {
        if (!dragging || !movable) return;
        const r = $("track").getBoundingClientRect();
        const frac = (e.clientX - r.left - 8) / Math.max(r.width - 16, 1);
        const s = clamp(frac * dur, GAP * i, Math.max(dur * 3, 30));
        if (Math.abs(s - S0[i]) > 0.05) moved = true;
        S = S0.slice();
        S[i] = s;
        for (let j = 0; j < i; j++) S[j] = Math.min(S0[j], s - GAP * (i - j));
        for (let j = i + 1; j < n; j++) S[j] = Math.max(S0[j], s + GAP * (j - i));
        newDur = i === n - 1 ? s : Math.max(dur, S[n - 1]);
        [...marks.children].forEach((el, j) => {
          el.style.left = "calc(8px + (100% - 16px) * " + S[j] / newDur + ")";
          el.lastChild.textContent = fmtT(S[j]);
        });
        $("clock").textContent = "length " + fmtT(newDur);
      });
      mk.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
          const d = Math.max(+newDur.toFixed(1), 2);
          pathData.duration = d;
          for (let j = 1; j < n - 1; j++) wps[j].t = +(S[j] / d).toFixed(4);
          save();
          rebuildPath();
          hudFlash("Point " + (i + 1) + " at " + fmtT(S[i]) + " · video length " + fmtT(d));
        } else jumpTo(i);
      });
      mk.addEventListener("dblclick", () => {
        if (!movable || wps[i].t == null) return;
        delete wps[i].t;
        save();
        rebuildPath();
        hudFlash("Point " + (i + 1) + " timing reset");
      });
      marks.appendChild(mk);
    }
    const row = document.createElement("div");
    row.className = "pt" + cls;
    const dflt = i === 0 ? "Start" : i === n - 1 ? "End" : "Point";
    const nm = wps[i].name;
    row.innerHTML = "<b>" + (i + 1) + "</b><span class=\"nm" + (nm ? "" : " dflt") + "\"></span><em>" + (curve ? fmtT(u * dur) : "–") + "</em><button class=\"ren\" title=\"Rename\">✎</button>";
    row.querySelector(".nm").textContent = nm || dflt;
    const startRename = () => {
      const span = row.querySelector(".nm");
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = nm || "";
      inp.placeholder = dflt;
      inp.maxLength = 40;
      inp.className = "nmIn";
      span.replaceWith(inp);
      inp.focus();
      inp.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit) {
          const v = inp.value.trim();
          if (v) wps[i].name = v;
          else delete wps[i].name;
          save();
        }
        renderTimeline();
      };
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      inp.addEventListener("blur", () => finish(true));
      inp.addEventListener("click", (e) => e.stopPropagation());
    };
    row.querySelector(".ren").addEventListener("click", (e) => {
      e.stopPropagation();
      startRename();
    });
    row.querySelector(".nm").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename();
    });
    row.addEventListener("click", () => jumpTo(i));
    list.appendChild(row);
  });
}

// The route is a chain of cubic bezier segments. Each point has one smooth tangent handle H:
// the curve leaves the point along +H and arrives along +H, so dragging it bends the path there.
class BezierPath extends THREE.Curve {
  constructor(pts, hs, hi) {
    super();
    this.pts = pts;
    this.hs = hs; // leaving handle of each point
    this.hi = hi || hs; // arriving handle of each point
  }
  getPoint(t, target = new THREE.Vector3()) {
    const n = this.pts.length - 1;
    const s = clamp(t, 0, 1) * n;
    const i = Math.min(Math.floor(s), n - 1);
    const f = s - i, g = 1 - f;
    const p0 = this.pts[i], p3 = this.pts[i + 1];
    const p1 = _b1.copy(p0).add(this.hs[i]);
    const p2 = _b2.copy(p3).sub(this.hi[i + 1]);
    const a = g * g * g, b = 3 * g * g * f, c = 3 * g * f * f, d = f * f * f;
    return target.set(
      a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      a * p0.z + b * p1.z + c * p2.z + d * p3.z
    );
  }
}
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();
// automatic handles (used until you drag one): the path leaves and arrives along one smooth direction, and each side is
// a third of the distance to that side's neighbour, so a short hop never squeezes the curve into a sharp corner
function autoHandles(i, pts) {
  const n = pts.length, p = pts[i];
  const dl = i > 0 ? p.distanceTo(pts[i - 1]) : 0, dr = i < n - 1 ? p.distanceTo(pts[i + 1]) : 0;
  const dir = new THREE.Vector3();
  if (i > 0 && dl > 1e-9) dir.add(p.clone().sub(pts[i - 1]).divideScalar(dl));
  if (i < n - 1 && dr > 1e-9) dir.add(pts[i + 1].clone().sub(p).divideScalar(dr));
  if (dir.lengthSq() < 1e-12) return { out: new THREE.Vector3(), inn: new THREE.Vector3() };
  dir.normalize();
  return { out: dir.clone().multiplyScalar(dr / 3), inn: dir.clone().multiplyScalar(dl / 3) };
}
function handleVecs(wps) {
  const pts = wps.map((w) => new THREE.Vector3(...w.p));
  const out = [], inn = [];
  wps.forEach((w, i) => {
    if (w.h) {
      // your handle sets the direction and strength, but is capped to 60% of the way to each neighbour so it cannot loop the path
      const v = new THREE.Vector3(...w.h);
      const dl = i > 0 ? pts[i].distanceTo(pts[i - 1]) : Infinity, dr = i < pts.length - 1 ? pts[i].distanceTo(pts[i + 1]) : Infinity;
      out.push(v.clone().clampLength(0, 0.6 * dr));
      // w.hb: a separate arriving handle, set when one side was dragged on its own (Alt / Cmd + drag)
      inn.push((w.hb ? new THREE.Vector3(...w.hb) : v.clone()).clampLength(0, 0.6 * dl));
    } else {
      const a = autoHandles(i, pts);
      out.push(a.out);
      inn.push(a.inn);
    }
  });
  return { pts, hs: out, hi: inn };
}
// the two handle ends of a point (forward = +H, back = -H), for drawing and picking
function tangentEnds(i, out) {
  const wps = pathData.waypoints;
  const { pts, hs, hi } = handleVecs(wps);
  const p = pts[i];
  out.fwd = p.clone().add(hs[i]);
  out.back = p.clone().sub(hi[i]);
  return out;
}
function makeTangentHandle() {
  const S = 96, c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  x.translate(S / 2, S / 2);
  x.rotate(Math.PI / 4);
  x.fillStyle = "#b388ff";
  x.strokeStyle = "#111";
  x.lineWidth = 8;
  x.fillRect(-26, -26, 52, 52);
  x.strokeRect(-26, -26, 52, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
}
const _te = {};
function pickTangent(e) {
  if (selected < 0 || !pathData.waypoints[selected] || pathData.waypoints.length < 2) return null;
  const n = pathData.waypoints.length;
  tangentEnds(selected, _te);
  let best = null, bestD = 20;
  for (const side of ["fwd", "back"]) {
    if ((side === "back" && selected === 0) || (side === "fwd" && selected === n - 1)) continue;
    const sp = toScreen(_te[side]);
    if (!sp) continue;
    const d = Math.hypot(sp[0] - e.clientX, sp[1] - e.clientY);
    if (d < bestD) { bestD = d; best = { i: selected, side }; }
  }
  return best;
}

function rebuildPath() {
  const wps = pathData.waypoints;
  curve = null;
  wpU = [];
  wpT = [];
  if (pathLine) {
    overlay.remove(pathLine);
    pathLine.geometry.dispose();
    pathLine = null;
  }
  disposeGroup(markers);
  if (selected >= wps.length) selected = wps.length - 1;
  if (wps.length >= 2) {
    const { pts, hs, hi } = handleVecs(wps);
    curve = new BezierPath(pts, hs, hi);
    const per = 100;
    curve.arcLengthDivisions = (wps.length - 1) * per;
    curve.updateArcLengths();
    const lens = curve.getLengths((wps.length - 1) * per);
    const total = lens[lens.length - 1] || 1;
    wpU = wps.map((_, i) => lens[i * per] / total);
    wpU[0] = 0;
    wpU[wps.length - 1] = 1;
    // timeline position: custom (dragged) time if set, else wherever the point sits along the route
    const N = wps.length;
    wpT = wps.map((w, i) => (i === 0 ? 0 : i === N - 1 ? 1 : w.t ?? wpU[i]));
    for (let i = 1; i < N - 1; i++) wpT[i] = clamp(wpT[i], wpT[i - 1] + T_GAP, 1 - T_GAP * (N - 1 - i));
    buildTimeMap();
    buildRotations(wps);
    buildTracks();
  }
  if (AUTHOR) {
    const r = diag * 0.005;
    if (curve) {
      // path as a thin tube with a start -> end colour gradient, so the flow direction reads at a glance
      const segs = Math.max(120, wps.length * 60);
      const radial = 6;
      const g = new THREE.TubeGeometry(curve, segs, diag * 0.0016, radial, false);
      const cols = new Float32Array(g.attributes.position.count * 3);
      const c0 = new THREE.Color(0x6ee7a8), c1 = new THREE.Color(0xffb454), c2 = new THREE.Color(0xff5c8a);
      const tmp = new THREE.Color();
      for (let i = 0; i < g.attributes.position.count; i++) {
        const t = Math.floor(i / (radial + 1)) / segs;
        if (t < 0.5) tmp.copy(c0).lerp(c1, t * 2);
        else tmp.copy(c1).lerp(c2, (t - 0.5) * 2);
        cols.set([tmp.r, tmp.g, tmp.b], i * 3);
      }
      g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      pathLine = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false }));
      pathLine.renderOrder = 999;
      overlay.add(pathLine);

      // direction arrows every ~6% of the route
      const up = new THREE.Vector3(0, 1, 0);
      const arrows = Math.max(4, Math.round(1 / 0.06));
      for (let k = 1; k < arrows; k++) {
        const u = k / arrows;
        const p = curve.getPointAt(u);
        const tan = curve.getTangentAt(u).normalize();
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(r * 0.38, r * 1.3, 8),
          new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.6 })
        );
        cone.position.copy(p);
        cone.quaternion.setFromUnitVectors(up, tan);
        cone.renderOrder = 1000;
        markers.add(cone);
      }
    }
    wps.forEach((w, i) => {
      const sel = i === selected;
      const color = sel ? 0x5cc8ff : i === 0 ? 0x6ee7a8 : i === wps.length - 1 ? 0xff5c8a : 0xffb454;
      // the point itself: a numbered ball (one sprite, so the number can never drift off the ball)
      const m = makeBall(i + 1, color, sel);
      m.position.set(...w.p);
      m.userData.k = sel ? 1.35 : 1;
      m.renderOrder = 1001;
      markers.add(m);

      // look direction: a short line + dot showing where the camera is aimed at this point
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...w.q));
      const tip = m.position.clone().addScaledVector(dir, LOOK_LEN());
      const look = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([m.position.clone(), tip]),
        new THREE.LineBasicMaterial({ color: sel ? 0x5cc8ff : 0xffffff, depthTest: false, transparent: true, opacity: 0.8 })
      );
      look.renderOrder = 1001;
      markers.add(look);
      const dot = makeHandle(sel);
      dot.userData.k = sel ? 0.5 : 0.32;
      dot.position.copy(tip);
      dot.renderOrder = 1002;
      markers.add(dot);


    });
    // curve handles of the selected point (purple diamonds): drag to bend the path there
    if (editing && selected >= 0 && wps.length >= 2) {
      tangentEnds(selected, _te);
      const w = wps[selected];
      const ends = [];
      if (selected < wps.length - 1) ends.push(_te.fwd);
      if (selected > 0) ends.push(_te.back);
      const base = new THREE.Vector3(...w.p);
      ends.forEach((pt) => {
        const ln = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([base, pt]),
          new THREE.LineBasicMaterial({ color: 0xb388ff, depthTest: false, transparent: true, opacity: 0.9 })
        );
        ln.renderOrder = 1001;
        markers.add(ln);
        const hd = makeTangentHandle();
        hd.position.copy(pt);
        hd.userData.k = 0.55;
        hd.renderOrder = 1002;
        markers.add(hd);
      });
    }
  }
  updateHud();
  renderTimeline();
  speedDirty = true;
}

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
// Camera rotation between points: SQUAD (a smooth quaternion spline) instead of an ease-in/out at every point,
// so the view keeps turning steadily through a point rather than stopping and starting.
let rotQ = [], rotS = [];
const qLog = (q) => {
  const s = Math.hypot(q.x, q.y, q.z);
  if (s < 1e-9) return new THREE.Vector3();
  const a = Math.atan2(s, q.w) / s;
  return new THREE.Vector3(q.x * a, q.y * a, q.z * a);
};
const qExp = (v) => {
  const a = v.length();
  if (a < 1e-9) return new THREE.Quaternion();
  const s = Math.sin(a) / a;
  return new THREE.Quaternion(v.x * s, v.y * s, v.z * s, Math.cos(a));
};
function buildRotations(wps) {
  const n = wps.length;
  rotQ = wps.map((w) => new THREE.Quaternion(...w.q).normalize());
  for (let i = 1; i < n; i++) if (rotQ[i].dot(rotQ[i - 1]) < 0) rotQ[i].set(-rotQ[i].x, -rotQ[i].y, -rotQ[i].z, -rotQ[i].w);
  rotS = rotQ.map((q, i) => {
    const inv = q.clone().invert();
    const l1 = i < n - 1 ? qLog(inv.clone().multiply(rotQ[i + 1])) : new THREE.Vector3();
    const l0 = i > 0 ? qLog(inv.clone().multiply(rotQ[i - 1])) : new THREE.Vector3();
    return q.clone().multiply(qExp(l1.add(l0).multiplyScalar(-0.25)));
  });
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
// The camera follows the route and the headings you authored exactly, with no filtering. Filtering rounds corners off by letting
// the camera drift past or lag behind a point, which is what shows up as sway. Position comes straight from the route and the speed
// graph. Heading and tilt are each one smooth curve through your points that is monotone: between two points it only ever goes
// one way, so it can never overshoot and swing back, and it eases to a stop wherever the view holds or the turn changes direction.
let rotSpline = null, posTrack = null, posM = 0;
// Position: the route can have tight corners where you bent it hard. A gentle filter (run forward and then backward, so it adds no
// lag and cannot overshoot) rounds only those corners off. It is deliberately light, and nothing is added back afterwards.
const POS_HZ = 30, POS_TAU = 0.7;
function pchip(xs, ys) {
  const n = xs.length, h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(Math.max(xs[i + 1] - xs[i], 1e-9)); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = new Array(n).fill(0); // the first and last views start and finish at rest
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); // weighted harmonic mean: never steeper than either side, so no overshoot
  }
  return { xs, ys, m, h };
}
function pchipAt(sp, x) {
  const n = sp.xs.length;
  let j = 0;
  while (j < n - 2 && x > sp.xs[j + 1]) j++;
  const h = sp.h[j], t = clamp((x - sp.xs[j]) / h, 0, 1), t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * sp.ys[j] + (t3 - 2 * t2 + t) * h * sp.m[j] + (-2 * t3 + 3 * t2) * sp.ys[j + 1] + (t3 - t2) * h * sp.m[j + 1];
}
function buildTracks() {
  rotSpline = null;
  posTrack = null;
  const n = pathData.waypoints.length;
  if (n < 2 || !curve) return;
  const fwd = new THREE.Vector3(), yaw = [], pit = [];
  for (let i = 0; i < n; i++) {
    fwd.set(0, 0, -1).applyQuaternion(rotQ[i]);
    pit.push(Math.asin(clamp(fwd.y, -1, 1)));
    let y = Math.abs(fwd.y) > 0.998 && i > 0 ? yaw[i - 1] : Math.atan2(-fwd.x, -fwd.z); // looking straight up or down: keep the heading
    if (i > 0) y += 2 * Math.PI * Math.round((yaw[i - 1] - y) / (2 * Math.PI)); // each turn the short way round
    yaw.push(y);
  }
  rotSpline = { yaw: pchip(wpT, yaw), pit: pchip(wpT, pit) };
  const dur = Math.max(pathData.duration, 2), M = Math.max(8, Math.ceil(dur * POS_HZ) + 1);
  const ps = [];
  for (let k = 0; k < M; k++) ps.push(curve.getPointAt(clamp(tlToU(k / (M - 1)), 0, 1), new THREE.Vector3()));
  const pad = Math.ceil(POS_HZ * 4 * POS_TAU), a = 1 - Math.exp(-1 / POS_HZ / POS_TAU);
  const P = [...Array(pad).fill(ps[0]), ...ps, ...Array(pad).fill(ps[M - 1])].map((v) => v.clone());
  for (let r = 0; r < 2; r++) {
    for (let k = 1; k < P.length; k++) P[k].lerpVectors(P[k - 1], P[k], a);
    for (let k = P.length - 2; k >= 0; k--) P[k].lerpVectors(P[k + 1], P[k], a);
  }
  posTrack = P.slice(pad, pad + M);
  posM = M;
}
const _camEuler = new THREE.Euler(0, 0, 0, "YXZ");
// pose at timeline position tau (0..1)
function samplePathT(tau, outPos, outQuat) {
  tau = clamp(tau, 0, 1);
  if (posTrack) {
    const sp = tau * (posM - 1), i = Math.min(Math.floor(sp), posM - 2);
    outPos.copy(posTrack[i]).lerp(posTrack[i + 1], sp - i);
  } else curve.getPointAt(clamp(tlToU(tau), 0, 1), outPos);
  if (!rotSpline) return;
  _camEuler.set(pchipAt(rotSpline.pit, tau), pchipAt(rotSpline.yaw, tau), 0, "YXZ");
  outQuat.setFromEuler(_camEuler);
}
// debugging helper (author mode): the camera pose the tour really uses at a time, as x y z + yaw pitch roll in degrees
if (AUTHOR) window.__cam = (sec) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(); samplePathT(sec / Math.max(pathData.duration, 1), p, q); e.setFromQuaternion(q, "YXZ"); return [p.x, p.y, p.z, e.y * R2D, e.x * R2D, e.z * R2D]; };
function samplePath(u, outPos, outQuat) {
  const wps = pathData.waypoints;
  u = clamp(u, 0, 1);
  curve.getPointAt(u, outPos);
  let j = 0;
  while (j < wps.length - 2 && u > wpU[j + 1]) j++;
  const span = Math.max(wpU[j + 1] - wpU[j], 1e-6);
  const l = clamp((u - wpU[j]) / span, 0, 1);
  _qa.copy(rotQ[j]).slerp(rotQ[j + 1], l);
  _qb.copy(rotS[j]).slerp(rotS[j + 1], l);
  outQuat.copy(_qa).slerp(_qb, 2 * l * (1 - l));
}

/* ------------------------------------------------------------------ *
 *  Tour state
 * ------------------------------------------------------------------ */
let tourU = 0,
  tourTarget = 0,
  playing = false;
let lookYaw = 0,
  lookPitch = 0;
const _p = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _off = new THREE.Quaternion();
const _tq = new THREE.Quaternion();

// Where on the tour path is closest to a spot in the scene (coarse scan, then a finer pass around the best hit).
const _np = new THREE.Vector3(), _nq = new THREE.Quaternion();
function nearestTourU(pos) {
  let best = 0, bd = Infinity;
  const scan = (a, b, n) => {
    for (let i = 0; i <= n; i++) {
      const u = a + ((b - a) * i) / n;
      samplePathT(u, _np, _nq);
      const d = _np.distanceToSquared(pos);
      if (d < bd) { bd = d; best = u; }
    }
  };
  scan(0, 1, 600);
  scan(Math.max(0, best - 0.003), Math.min(1, best + 0.003), 60);
  return best;
}
function setMode(m, immediate, keepPlayhead) {
  if (m === "tour" && !curve) return;
  if (mode === "free" && m === "tour" && !AUTHOR && !immediate) {
    // Visitors: pick the tour up from the spot nearest to where they are, hidden behind a quick dip to black.
    const veil = $("veil");
    const u = nearestTourU(camera.position);
    if (!veil || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode("tour", true);
      return snapTour(u);
    }
    clearTimeout(setMode.t);
    veil.style.transitionDuration = "0.22s";
    veil.style.opacity = "1";
    setMode.t = setTimeout(() => {
      setMode("tour", true);
      snapTour(u);
      veil.style.transitionDuration = "0.45s";
      veil.style.opacity = "0";
    }, 240);
    return;
  }
  if (mode === "free" && m === "tour") {
    // keep the playhead where it was, so going back to the tour resumes instead of restarting; with a point selected it starts at that point
    if (AUTHOR && !keepPlayhead && selected >= 0 && wpT[selected] != null) snapTour(wpT[selected]); // start right at the selected point
    else tourU = tourTarget;
    lookYaw = lookPitch = 0;
  }
  if (mode === "tour" && m === "free") {
    syncYawPitchFromCamera();
    playing = false;
  }
  mode = m;
  document.body.dataset.mode = mode;
  $("modeBtn").textContent = mode === "tour" ? "Explore freely" : "Back to tour";
  $("playBtn").textContent = playing ? "❚❚" : "▶";
  updateHud();
}

function startPose() {
  const wps = pathData.waypoints;
  if (wps.length) {
    camera.position.set(...wps[0].p);
    camera.quaternion.set(...wps[0].q);
    syncYawPitchFromCamera();
  } else {
    camera.position.copy(center);
    yaw = 0;
    pitch = 0;
    setCameraFromYawPitch();
  }
}

/* ------------------------------------------------------------------ *
 *  Input
 * ------------------------------------------------------------------ */
let drag = null;
const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _pv = new THREE.Vector3();

function toScreen(v3) {
  _pv.copy(v3).project(camera);
  if (_pv.z > 1 || _pv.z < -1) return null;
  const r = canvas.getBoundingClientRect();
  return [(_pv.x * 0.5 + 0.5) * r.width + r.left, (-_pv.y * 0.5 + 0.5) * r.height + r.top];
}
function setRay(e) {
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
}
// nearest waypoint within ~18px of the pointer (screen space, so it works through walls)
function pickWaypoint(e) {
  let best = -1, bestD = 30;
  pathData.waypoints.forEach((w, i) => {
    const sp = toScreen(_v3.set(...w.p));
    if (!sp) return;
    const d = Math.hypot(sp[0] - e.clientX, sp[1] - e.clientY);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
const _v3 = new THREE.Vector3();

function selectPoint(i, msg) {
  selected = i;
  rebuildPath();
  if (msg && i >= 0) hudFlash("Point " + (i + 1) + " selected · drag to move · V view · U update · ⌫ delete");
}

canvas.addEventListener("pointerdown", (e) => {
  drag = { type: e.pointerType, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, point: -1, look: -1, tan: null };
  if (AUTHOR && !preview && !editing && mode === "free" && e.button === 0 && pickWaypoint(e) >= 0) {
    hudFlash("Turn on ✎ Edit path (top right, or press M) to move points");
  }
  if (AUTHOR && !preview && editing && mode === "free" && e.button === 0) {
    const th = pickTangent(e);
    if (th) {
      drag.tan = th;
      drag.tan.solo = e.altKey || e.metaKey; // Alt (Option) or Cmd: bend only this side of the point
      if (drag.tan.solo) {
        const wq = pathData.waypoints[th.i];
        if (!wq.h || !wq.hb) {
          const hv = handleVecs(pathData.waypoints);
          if (!wq.h) wq.h = hv.hs[th.i].toArray().map((x) => +x.toFixed(5));
          if (!wq.hb) wq.hb = hv.hi[th.i].toArray().map((x) => +x.toFixed(5));
        }
        hudFlash("One side only · the other side stays put");
      }
      tangentEnds(th.i, _te);
      const tp = _te[th.side];
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(e.shiftKey ? new THREE.Vector3(0, 1, 0) : camera.getWorldDirection(new THREE.Vector3()), tp);
      setRay(e);
      const h0 = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
      drag.offset = h0 ? h0.sub(tp) : new THREE.Vector3();
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add("dragging");
      return;
    }
    const lk = pickLook(e);
    if (lk >= 0) {
      drag.look = lk;
      if (selected !== lk) selectPoint(lk);
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add("dragging");
      return;
    }
    const hit = pickWaypoint(e);
    if (hit >= 0) {
      drag.point = hit;
      const w = pathData.waypoints[hit];
      const p = new THREE.Vector3(...w.p);
      // drag plane: facing the camera, or horizontal when Shift is held (keeps height)
      const normal = e.shiftKey ? new THREE.Vector3(0, 1, 0) : camera.getWorldDirection(new THREE.Vector3());
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p);
      setRay(e);
      drag.offset = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3()) ? _hit.copy(raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3())).sub(p).clone() : new THREE.Vector3();
      if (selected !== hit) selectPoint(hit, true);
    }
  }
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  document.body.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (AUTHOR && !preview && editing && !drag && mode === "free") canvas.style.cursor = pickTangent(e) || pickLook(e) >= 0 || pickWaypoint(e) >= 0 ? "grab" : "crosshair";
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  if (drag.tan) {
    setRay(e);
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (hit) {
      hit.sub(drag.offset);
      const w = pathData.waypoints[drag.tan.i];
      const v = hit.sub(new THREE.Vector3(...w.p));
      if (drag.tan.side === "back") v.negate();
      const va = v.toArray().map((x) => +x.toFixed(5));
      if (drag.tan.solo) {
        if (drag.tan.side === "back") w.hb = va;
        else w.h = va;
      } else {
        w.h = va;
        delete w.hb;
      }
      rebuildPath();
    }
    return;
  }
  if (drag.look >= 0) {
    // aim: where the pointer ray meets a sphere around the point (or its closest approach)
    setRay(e);
    const w = pathData.waypoints[drag.look];
    const c = _lt.set(...w.p);
    const L = LOOK_LEN();
    const ray = raycaster.ray;
    const curTip = lookTip(drag.look, new THREE.Vector3());
    const oc = ray.origin.clone().sub(c);
    const bq = oc.dot(ray.direction), disc = bq * bq - (oc.lengthSq() - L * L);
    let dirv;
    if (disc >= 0) {
      // the ray crosses the sphere twice; take the crossing nearest the current handle so it never flips to the far side
      const sq = Math.sqrt(disc);
      const a1 = ray.at(-bq - sq, new THREE.Vector3()), a2 = ray.at(-bq + sq, new THREE.Vector3());
      dirv = (a1.distanceToSquared(curTip) < a2.distanceToSquared(curTip) ? a1 : a2).sub(c);
    } else {
      const t = Math.max(0, ray.direction.dot(c.clone().sub(ray.origin)));
      dirv = ray.at(t, new THREE.Vector3()).sub(c);
    }
    if (dirv.lengthSq() > 1e-9) {
      dirv.normalize();
      const up = Math.abs(dirv.y) > 0.98 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const mat = new THREE.Matrix4().lookAt(c, c.clone().add(dirv), up);
      w.q = new THREE.Quaternion().setFromRotationMatrix(mat).toArray().map((v) => +v.toFixed(6));
      rebuildPath();
    }
    return;
  }
  if (drag.point >= 0) {
    setRay(e);
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (hit) {
      hit.sub(drag.offset);
      pathData.waypoints[drag.point].p = hit.toArray().map((v) => +v.toFixed(5));
      rebuildPath();
    }
    return;
  }
  const dx = e.clientX - drag.x,
    dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (mode === "free") {
    const sens = drag.type === "touch" ? 0.0042 : 0.003; // fingers need a little more turn per pixel
    yaw -= dx * sens;
    pitch = clamp(pitch - dy * sens, -1.5, 1.5);
    setCameraFromYawPitch();
  } else {
    // Dragging the scene only ever looks around (360° sideways, up and down); on a phone too. Only the timeline bar moves playback.
    const sens = drag.type === "touch" ? 0.0042 : 0.003;
    lookYaw = wrapPi(lookYaw - dx * sens);
    lookPitch = clamp(lookPitch - dy * sens, -1.45, 1.45);
  }
});
const wrapPi = (a) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2)); // keep an angle in -180°..180° so easing back takes the short way round
const endDrag = () => {
  if (drag) {
    if ((drag.point >= 0 || drag.look >= 0 || drag.tan) && drag.moved) save();
    // plain click on empty space = deselect
    else if (AUTHOR && !preview && drag.point < 0 && drag.look < 0 && !drag.tan && !drag.moved && selected >= 0) selectPoint(-1);
  }
  drag = null;
  document.body.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// double-click on the path line = add a point right there
canvas.addEventListener("dblclick", (e) => {
  if (!AUTHOR || preview || !editing || mode !== "free") return;
  const th = pickTangent(e);
  if (th) {
    delete pathData.waypoints[th.i].h;
    delete pathData.waypoints[th.i].hb;
    save();
    rebuildPath();
    return hudFlash("Curve handle reset");
  }
  if (!curve) return;
  const N = 400;
  const pts = curve.getSpacedPoints(N);
  let best = -1, bestD = 14;
  pts.forEach((p, i) => {
    const sp = toScreen(p);
    if (!sp) return;
    const d = Math.hypot(sp[0] - e.clientX, sp[1] - e.clientY);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return;
  const u = best / N;
  const wps = pathData.waypoints;
  let j = 0;
  while (j < wps.length - 2 && u > wpU[j + 1]) j++;
  samplePath(u, _p, _pq);
  wps.splice(j + 1, 0, {
    p: _p.toArray().map((v) => +v.toFixed(5)),
    q: _pq.toArray().map((v) => +v.toFixed(6)),
  });
  selected = j + 1;
  save();
  rebuildPath();
  hudFlash("Point added · drag it to shape the route");
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (mode === "tour") {
      tourTarget = clamp(tourTarget + e.deltaY * 0.0003, 0, 1);
      playing = false;
      $("playBtn").textContent = "▶";
    } else {
      speedMul = clamp(speedMul * Math.pow(1.0015, -e.deltaY), 0.05, 40);
    }
  },
  { passive: false }
);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (AUTHOR && !preview && (e.ctrlKey || e.metaKey) && (k === "c" || k === "x" || k === "v")) {
    e.preventDefault();
    return clipboardOp(k, e.shiftKey);
  }
  if (AUTHOR && !preview && eraseOn && ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y") || k === "backspace")) {
    // eraser is open: undo / redo applies to the erased spots
    e.preventDefault();
    return eraseStep(k === "y" || (k === "z" && e.shiftKey) ? 1 : -1);
  }
  if (AUTHOR && !preview && (e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
    e.preventDefault();
    return stepHistory(k === "y" || e.shiftKey ? 1 : -1);
  }
  if (k === "r" && !e.ctrlKey && !e.metaKey) return resetView();
  if (AUTHOR && !preview && (e.key === "`" || e.code === "Backquote") && !e.ctrlKey && !e.metaKey) {
    // ` shows / hides the author help panel
    e.preventDefault();
    helpHidden = !helpHidden;
    try { localStorage.setItem("china26-help-hidden", helpHidden ? "1" : "0"); } catch {}
    return updateHud();
  }
  if (AUTHOR && !preview && k === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) return setErase(!eraseOn);
  if (k === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    // T flips between the guided tour and free roam (needs a path to tour along)
    if (mode === "tour") return setMode("free");
    if (curve) return setMode("tour");
    return;
  }
  // editor: flying keys during a preview take over the camera from where it is
  if (AUTHOR && !preview && mode === "tour" && ["w", "a", "s", "d", "q", "e"].includes(k) && !e.ctrlKey && !e.metaKey && !e.altKey) setMode("free");
  if (mode === "free") {
    if (["w", "a", "s", "d", "q", "e", "shift"].includes(k)) keys.add(k);
  }
  if (AUTHOR && preview && k === "escape") return setPreview(false);
  if (AUTHOR && !preview) {
    // Space while the pointer is over the playbar = play / pause (instead of dropping a point)
    if (k === " " && overBar && curve) {
      e.preventDefault();
      if (mode !== "tour") setMode("tour", false, true);
      togglePlay();
      return;
    }
    if (k === " " && mode === "free") {
      e.preventDefault();
      if (!editing) return hudFlash("Turn on Edit (M) to add points");
      addWaypoint();
      return;
    }
    if (k === "backspace" || k === "delete") {
      e.preventDefault();
      if (e.shiftKey) {
        pathData.waypoints = [];
        selected = -1;
      } else if (selected >= 0) {
        pathData.waypoints.splice(selected, 1);
        selected = Math.min(selected, pathData.waypoints.length - 1);
      } else {
        pathData.waypoints.pop();
      }
      save();
      rebuildPath();
      if (!curve && mode === "tour") setMode("free");
      return;
    }
    if (k === "m") return setEditing(!editing);
    if (k === "l") return window.__togglePts();
    if (k === "escape") return selectPoint(-1);
    if (k === "v" && selected >= 0) return viewFrom(selected);
    if (k === "u" && selected >= 0 && mode === "free") {
      const w = pathData.waypoints[selected];
      w.p = camera.position.toArray().map((v) => +v.toFixed(5));
      w.q = camera.quaternion.toArray().map((v) => +v.toFixed(6));
      save();
      rebuildPath();
      return hudFlash("Point " + (selected + 1) + " updated to this view");
    }
    if ((k === "[" || k === "]") && pathData.waypoints.length) {
      const n = pathData.waypoints.length;
      const i = selected < 0 ? (k === "]" ? 0 : n - 1) : (selected + (k === "]" ? 1 : -1) + n) % n;
      selectPoint(i);
      return viewFrom(i);
    }
    if (k === "o") return cycleOrientation();
    if (k === "g") {
      GROUND.on = !GROUND.on;
      return hudFlash("Ground lock " + (GROUND.on ? "on" : "off"));
    }
    if (k === "t") return setMode(mode === "tour" ? "free" : "tour");
    if (k === "p" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // P drops a point, same as Space (only while flying; in preview mode there is nothing to add to)
      e.preventDefault();
      if (!editing) return hudFlash("Turn on Edit (M) to add points");
      if (mode === "tour") {
        // Works straight from the tour view: captures the camera as it is right now (including any look-around
        // from dragging) at the playhead, pauses, and clears the look offset since it is baked into the point.
        playing = false;
        $("playBtn").textContent = "▶";
        addWaypoint();
        lookYaw = lookPitch = 0;
        return;
      }
      addWaypoint();
      return;
    }
    if (k === "p") {
      if (!curve) return;
      setMode("tour");
      tourU = tourTarget = 0;
      playing = true;
      $("playBtn").textContent = "❚❚";
      return;
    }
    if (k === "x") return downloadPath();
  }
  if (mode === "tour") {
    if (k === " ") {
      e.preventDefault();
      togglePlay();
    }
    if (["arrowdown", "arrowright", "pagedown"].includes(k)) {
      tourTarget = clamp(tourTarget + 0.02, 0, 1);
      playing = false;
    }
    if (["arrowup", "arrowleft", "pageup"].includes(k)) {
      tourTarget = clamp(tourTarget - 0.02, 0, 1);
      playing = false;
    }
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => { keys.clear(); resetStick(); });

/* ---- touch controls for free roam: left stick moves, drag anywhere else to look, Up / Down buttons ---- */
const joy = { x: 0, y: 0, mag: 0 };
const padEl = $("pad"), stickEl = $("stick");
function resetStick() {
  joy.x = joy.y = joy.mag = 0;
  if (stickEl) { stickEl.style.transform = "translate(-50%,-50%)"; padEl.classList.remove("fast"); }
}
if (padEl) {
  let padId = null;
  const move = (e) => {
    const r = padEl.getBoundingClientRect();
    const R = r.width / 2 - 26;
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    joy.x = dx / R;
    joy.y = dy / R;
    joy.mag = Math.min(1, Math.hypot(joy.x, joy.y));
    stickEl.style.transform = "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px))";
    padEl.classList.toggle("fast", joy.mag > 0.95);
  };
  padEl.addEventListener("pointerdown", (e) => {
    padId = e.pointerId;
    try { padEl.setPointerCapture(e.pointerId); } catch {}
    move(e);
  });
  padEl.addEventListener("pointermove", (e) => { if (e.pointerId === padId) move(e); });
  const end = (e) => { if (e.pointerId === padId) { padId = null; resetStick(); } };
  padEl.addEventListener("pointerup", end);
  padEl.addEventListener("pointercancel", end);
  for (const [id, key] of [["upBtn", "e"], ["dnBtn", "q"]]) {
    const b = $(id);
    if (!b) continue;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch {} keys.add(key); b.classList.add("held"); });
    const up = () => { keys.delete(key); b.classList.remove("held"); };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
  }
  // leaving free fly mid-touch must not leave the camera drifting
  new MutationObserver(resetStick).observe(document.body, { attributes: true, attributeFilter: ["data-mode"] });
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ------------------------------------------------------------------ *
 *  UI
 * ------------------------------------------------------------------ */
function togglePlay() {
  if (!curve) return;
  if (!playing && tourTarget >= 0.999) tourU = tourTarget = 0;
  playing = !playing;
  $("playBtn").textContent = playing ? "❚❚" : "▶";
  // editor: pausing hands the camera back to you, right where the preview stopped, so you can keep flying and editing
  if (AUTHOR && !preview && !playing && mode === "tour") setMode("free");
}
let overBar = false;
$("ui").addEventListener("pointerenter", () => (overBar = true));
$("ui").addEventListener("pointerleave", () => (overBar = false));
$("playBtn").addEventListener("click", () => {
  if (mode !== "tour") setMode("tour", false, true);
  togglePlay();
});
$("modeBtn").addEventListener("click", () => {
  if (mode === "tour") {
    setMode("free");
  } else {
    if (curve) setMode("tour");
  }
});
$("slider").addEventListener("input", (e) => {
  tourTarget = Number(e.target.value) / 1000;
  playing = false;
  $("playBtn").textContent = "▶";
});

function resetView() {
  if (mode === "tour") {
    tourU = tourTarget = 0;
    playing = false;
    lookYaw = lookPitch = 0;
    $("playBtn").textContent = "▶";
    $("slider").value = 0;
  } else {
    const w = pathData.waypoints[0];
    if (w) {
      camera.position.set(...w.p);
      camera.quaternion.set(...w.q);
    } else {
      camera.position.copy(defaultStart.p);
      camera.quaternion.copy(defaultStart.q);
    }
    syncYawPitchFromCamera();
    vel.set(0, 0, 0);
  }
  hudFlash("Back to the start");
}
$("resetBtn").addEventListener("click", resetView);
// keep keyboard focus off buttons so Space never "clicks" them
document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLButtonElement) e.target.blur();
});

function addWaypoint() {
  const wp = {
    p: camera.position.toArray().map((v) => +v.toFixed(5)),
    q: camera.quaternion.toArray().map((v) => +v.toFixed(6)),
  };
  // If the playhead sits between two points, the new point goes between them (and takes that time on the timeline);
  // otherwise it goes after the selected point, or at the end.
  const wps = pathData.waypoints, EPS = 0.002;
  let between = -1;
  if (curve && wpT.length >= 2) {
    for (let j = 0; j < wpT.length - 1; j++) {
      if (tourTarget > wpT[j] + EPS && tourTarget < wpT[j + 1] - EPS) {
        between = j;
        break;
      }
    }
  }
  if (between >= 0) {
    wp.t = +tourTarget.toFixed(4);
    wps.splice(between + 1, 0, wp);
    selected = between + 1;
    hudFlash("Added as point " + (between + 2) + " · between " + (between + 1) + " and " + (between + 3));
  } else if (selected >= 0) {
    // a point is selected: slot the new one in right after it
    wps.splice(selected + 1, 0, wp);
    selected += 1;
  } else {
    wps.push(wp);
  }
  save();
  rebuildPath();
}

// copy / cut / paste of a point (author mode). Paste drops the copy where the camera is now (keeping its look direction
// and curve handle); Ctrl+Shift+V pastes it back at its original spot.
let pointClip = null;
function clipboardOp(k, inPlace) {
  const wps = pathData.waypoints;
  if (k === "c" || k === "x") {
    if (selected < 0 || !wps[selected]) return hudFlash("Select a point first");
    pointClip = JSON.parse(JSON.stringify(wps[selected]));
    delete pointClip.t;
    try { navigator.clipboard?.writeText(JSON.stringify(pointClip)); } catch {}
    if (k === "c") return hudFlash("Copied point " + (selected + 1) + " · Ctrl+V to paste");
    wps.splice(selected, 1);
    selected = Math.min(selected, wps.length - 1);
    save();
    rebuildPath();
    if (!curve && mode === "tour") setMode("free");
    return hudFlash("Cut point · Ctrl+V to paste");
  }
  if (!pointClip) return hudFlash("Nothing copied yet");
  const w = JSON.parse(JSON.stringify(pointClip));
  if (!inPlace && mode === "free") w.p = camera.position.toArray().map((v) => +v.toFixed(5));
  const at = selected >= 0 ? selected + 1 : wps.length;
  wps.splice(at, 0, w);
  selected = at;
  save();
  rebuildPath();
  hudFlash("Pasted as point " + (at + 1) + (inPlace || mode !== "free" ? " (original spot)" : " (at the camera)"));
}

function viewFrom(i) {
  const w = pathData.waypoints[i];
  if (!w) return;
  if (mode === "tour") setMode("free");
  camera.position.set(...w.p);
  camera.quaternion.set(...w.q);
  syncYawPitchFromCamera();
  vel.set(0, 0, 0);
  hudFlash("Viewing from point " + (i + 1));
}

function cycleOrientation() {
  const old = ORIENTATIONS[pathData.orientation];
  pathData.orientation = (pathData.orientation + 1) % ORIENTATIONS.length;
  const next = ORIENTATIONS[pathData.orientation];
  mesh.quaternion.copy(next);
  // keep existing waypoints glued to the splat
  const delta = next.clone().multiply(old.clone().invert());
  pathData.waypoints = pathData.waypoints.map((w) => {
    const p = new THREE.Vector3(...w.p).applyQuaternion(delta);
    const q = delta.clone().multiply(new THREE.Quaternion(...w.q));
    const out = { p: p.toArray(), q: q.toArray() };
    if (w.t != null) out.t = w.t;
    if (w.h) out.h = new THREE.Vector3(...w.h).applyQuaternion(delta).toArray();
    if (w.hb) out.hb = new THREE.Vector3(...w.hb).applyQuaternion(delta).toArray();
    if (w.v != null) out.v = w.v;
    if (w.vb != null) out.vb = w.vb;
    if (w.io != null) out.io = w.io;
    if (w.ii != null) out.ii = w.ii;
    return out;
  });
  save();
  rebuildPath();
  buildFloor();
  hudFlash("Orientation " + (pathData.orientation + 1) + " / " + ORIENTATIONS.length);
}

function downloadPath() {
  const blob = new Blob([JSON.stringify(pathData, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "path.json";
  a.click();
  URL.revokeObjectURL(a.href);
  hudFlash("Saved path.json to your Downloads folder");
}

let flashTimer = 0;
function hudFlash(msg) {
  const el = $("flash");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function updateHud() {
  const n = pathData.waypoints.length;
  document.body.classList.toggle("has-path", !!curve);
  if (!AUTHOR) return;
  $("author").hidden = preview || helpHidden;
  $("count").textContent = n + (n === 1 ? " point" : " points");
  $("modeLabel").textContent = mode === "tour" ? "previewing" : "free fly";
}

/* ------------------------------------------------------------------ *
 *  Frame loop
 * ------------------------------------------------------------------ */
let last = performance.now();
let tourOver = false;
let lastLook = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (mode === "free") {
    const s = baseSpeed() * speedMul * (keys.has("shift") ? 3 : 1);
    const wish = new THREE.Vector3();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    if (keys.has("w")) wish.add(fwd);
    if (keys.has("s")) wish.sub(fwd);
    if (keys.has("d")) wish.add(right);
    if (keys.has("a")) wish.sub(right);
    if (keys.has("e")) wish.y += 1;
    if (keys.has("q")) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(s);
    if (joy.mag > 0.08) {
      // touch stick: analog speed, push to the rim to sprint; Up / Down buttons still work through the keys set
      const jv = new THREE.Vector3().addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x);
      jv.multiplyScalar(s * (joy.mag > 0.95 ? 1.8 : 1));
      jv.y += wish.y;
      wish.copy(jv);
    }
    vel.lerp(wish, 1 - Math.exp(-dt * 10));
    camera.position.addScaledVector(vel, dt);
    if (GROUND.on && floorGrid) {
      const minY = floorAt(camera.position.x, camera.position.z) + clearance;
      if (camera.position.y < minY) {
        camera.position.y += (minY - camera.position.y) * Math.min(1, dt * 15);
        if (vel.y < 0) vel.y = 0;
      }
    }
    if (chapterEls.length) updateNowFree(camera.position);
  } else if (curve) {
    if (glide && tourTarget !== glide.last) glide = null; // the user scrubbed or scrolled: hand control back
    if (glide) {
      glide.t += dt;
      const x = Math.min(1, glide.t / glide.dur);
      const e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; // easeInOutCubic
      tourTarget = tourU = glide.from + (glide.to - glide.from) * e;
      glide.last = tourTarget;
      if (x >= 1) glide = null;
    } else if (playing) {
      tourTarget = Math.min(1, tourTarget + dt / Math.max(pathData.duration, 5));
      if (tourTarget >= 1) {
        playing = false;
        $("playBtn").textContent = "▶";
        if (AUTHOR && !preview) setMode("free"); // editor: at the end of the preview you are free to fly again
      }
    }
    tourU += (tourTarget - tourU) * (1 - Math.exp(-dt * (playing && !glide ? 40 : 4))); // while playing, follow the timeline closely: lag is what makes a camera feel like it sways
    samplePathT(tourU, _p, _pq);
    camera.position.copy(_p);
    if (drag) lastLook = now;
    else if (now - lastLook > 3500) {
      // hold wherever the visitor looked; drift back to the path's own heading only after a few idle seconds
      const k = Math.exp(-dt * 0.9);
      lookYaw *= k;
      lookPitch *= k;
    }
    _off.setFromEuler(euler.set(lookPitch, lookYaw, 0, "YXZ"));
    _tq.copy(_pq).multiply(_off);
    camera.quaternion.slerp(_tq, 1 - Math.exp(-dt * (playing && !glide ? 40 : 6)));
    if (chapterEls.length) updateNow(tourU);
    const over = tourTarget >= 0.999 && tourU >= 0.99;
    if (over !== tourOver) { tourOver = over; document.body.classList.toggle("ended", over); } // phones show Restart only once the tour is over
    if (document.activeElement !== $("slider")) $("slider").value = Math.round(tourTarget * 1000);
    if (AUTHOR) $("clock").textContent = fmtT(tourU * pathData.duration) + " / " + fmtT(pathData.duration);
  }

  if (AUTHOR) {
    // hide the route decorations while previewing so they do not clutter the shot
    markers.visible = mode !== "tour" && !preview;
    if (pathLine) pathLine.visible = mode !== "tour" && !preview;
    // keep number labels a steady size on screen, near or far
    for (const m of markers.children) {
      if (!m.isSprite) continue;
      const d = camera.position.distanceTo(m.position);
      const sc = clamp(d * 0.05, diag * 0.004, diag * 0.06) * (m.userData.k || 1);
      m.scale.set(sc, sc, 1);
    }
  }

  renderer.clear();
  renderer.render(scene, camera);
  if (AUTHOR && !preview) {
    renderer.clearDepth();
    renderer.render(overlay, camera);
    updateAuthorAids();
    if (speedOn && (speedDirty || speedLast !== tourTarget)) drawSpeed();
  } else if (AUTHOR) {
    // visitor preview: none of the author aids (coordinates, camera preview window and its Show button)
    $("coords").hidden = true;
    $("pip").hidden = true;
    $("pipChip").hidden = true;
    if (eraseOn) setErase(false);
  }
}

/* Author aids: live coordinates, and a window showing the selected point as the tour will actually show it. */
const pipCam = new THREE.PerspectiveCamera(camera.fov, 16 / 9, 0.01, 1000);
const _pipP = new THREE.Vector3(), _pipQ = new THREE.Quaternion(), _pipE = new THREE.Euler(0, 0, 0, "YXZ");
/* ---- Erase tool: click a stray splat, mark a ball around it, saved to erase.json for cleanup ---- */
const eraseList = []; // { p:[x,y,z] (world), r }
let eraseOn = false;
let eraseDirty = false;
let eraseEdit = null; // one SplatEdit on the splat mesh; each mark is a transparent ball inside it (live preview of the removal)
function drawErase() {
  if (!eraseEdit) {
    eraseEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0, sdfSmooth: 0 });
    mesh.add(eraseEdit);
  }
  for (const c of [...eraseEdit.children]) eraseEdit.remove(c);
  for (const e of eraseList) {
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.SPHERE, color: new THREE.Color(1, 1, 1), opacity: 0, radius: e.r });
    sdf.position.copy(mesh.worldToLocal(new THREE.Vector3().fromArray(e.p)));
    eraseEdit.add(sdf);
  }
  eraseDirty = true;
  $("eraseCount").textContent = eraseList.length + " erased";
  $("eraseMsg").textContent = eraseList.length ? "Not saved yet. Press Save & done when you are finished." : "";
}
const eraseRay = new THREE.Raycaster();
// undo / redo for the eraser: snapshots of the list (while erase mode is on, Ctrl+Z / Ctrl+Y / Backspace act here, not on the path)
const eraseUndoStack = [], eraseRedoStack = [];
function eraseStep(dir) {
  if (dir < 0) {
    if (!eraseUndoStack.length && !eraseList.length) return hudFlash("Nothing to undo");
    eraseRedoStack.push(eraseList.map((x) => ({ ...x })));
    const prev = eraseUndoStack.length ? eraseUndoStack.pop() : eraseList.slice(0, -1).map((x) => ({ ...x }));
    eraseList.length = 0; eraseList.push(...prev);
  } else {
    if (!eraseRedoStack.length) return hudFlash("Nothing to redo");
    eraseUndoStack.push(eraseList.map((x) => ({ ...x })));
    const next = eraseRedoStack.pop();
    eraseList.length = 0; eraseList.push(...next);
  }
  drawErase();
}
async function saveErase() {
  const body = JSON.stringify({ note: "world coordinates; splat file x,y,z = world x,-z,y", spheres: eraseList });
  try {
    const r = await fetch("/__erase", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!r.ok) throw new Error(r.status);
    eraseDirty = false;
    $("eraseMsg").textContent = "Saved to erase.json (" + eraseList.length + " marks). Tell Claude: apply the erase list.";
  } catch {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = "erase.json";
    a.click();
    $("eraseMsg").textContent = "Server can't save: downloaded erase.json instead. Restart start-author.bat to enable auto-save.";
  }
}
let editBeforeErase = false;
function setErase(on) {
  const wasOn = eraseOn;
  eraseOn = on;
  if (wasOn && !on && eraseDirty && eraseList.length) saveErase(); // one save, when you finish
  document.body.classList.toggle("erasing", on);
  $("eraseBtn").classList.toggle("on", on);
  $("erasePanel").hidden = !on;
  if (on && editing) { editBeforeErase = true; setEditing(false); }
  if (!on && wasOn && editBeforeErase) { editBeforeErase = false; if (!preview) setEditing(true); } // back to editing, so Erase and Auto-pace stay put
  if (on) $("eraseMsg").textContent = "";
}
if (AUTHOR) {
  $("eraseBtn").hidden = false;
  $("eraseBtn").addEventListener("click", () => setErase(!eraseOn));
  $("eraseDone").addEventListener("click", () => setErase(false));
  $("eraseSave").addEventListener("click", () => saveErase());
  $("eraseR").addEventListener("input", (e) => {
    const r = Number(e.target.value);
    $("eraseRv").textContent = r.toFixed(2) + " m";
    if (eraseList.length) { eraseList[eraseList.length - 1].r = r; drawErase(); }
  });
  $("eraseUndo").addEventListener("click", () => eraseStep(-1));
  $("eraseRedo").addEventListener("click", () => eraseStep(1));
  $("eraseClear").addEventListener("click", () => { eraseUndoStack.push(eraseList.map((x) => ({ ...x }))); eraseList.length = 0; eraseRedoStack.length = 0; drawErase(); });
  let down = null;
  canvas.addEventListener("pointerdown", (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  window.addEventListener("pointerup", (e) => {
    if (!eraseOn || preview || !down || e.target !== canvas) return;
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    down = null;
    $("eraseMsg").textContent = "Picking...";
    setTimeout(() => {
      eraseRay.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
      const hit = eraseRay.intersectObject(mesh, false)[0];
      if (!hit) { $("eraseMsg").textContent = "Nothing under the cursor. Try clicking right on the splat."; return; }
      eraseUndoStack.push(eraseList.map((x) => ({ ...x })));
      eraseRedoStack.length = 0;
      eraseList.push({ p: hit.point.toArray().map((v) => +v.toFixed(3)), r: Number($("eraseR").value) });
      drawErase();
    }, 20);
  });
}
let helpHidden = false;
try { helpHidden = localStorage.getItem("china26-help-hidden") === "1"; } catch {}
let aidTick = 0;
// size and hidden state of the camera preview window are remembered in this browser
let pipPrefs = { w: 440, hidden: false, x: null, y: null };
try { Object.assign(pipPrefs, JSON.parse(localStorage.getItem("china26-pip") || "{}")); } catch {}
const pipMaxW = () => Math.max(240, Math.min(960, window.innerWidth * 0.62));
function applyPipSize() {
  const w = Math.max(240, Math.min(pipMaxW(), pipPrefs.w));
  const h = Math.round((w * 9) / 16), el = $("pip");
  el.style.width = w + "px";
  el.style.height = h + "px";
  if (pipPrefs.x != null && pipPrefs.y != null) {
    // moved by hand: pinned by its top-left corner, kept on screen
    pipPrefs.x = Math.max(0, Math.min(window.innerWidth - w, pipPrefs.x));
    pipPrefs.y = Math.max(0, Math.min(window.innerHeight - h, pipPrefs.y));
    el.style.left = pipPrefs.x + "px";
    el.style.top = pipPrefs.y + "px";
    el.style.right = el.style.bottom = "auto";
  } else {
    el.style.left = el.style.top = el.style.right = el.style.bottom = "";
  }
}
function savePip() { try { localStorage.setItem("china26-pip", JSON.stringify(pipPrefs)); } catch {} }
if (AUTHOR) {
  applyPipSize();
  $("pipHide").addEventListener("click", () => { pipPrefs.hidden = true; savePip(); });
  $("pipChip").addEventListener("click", () => { pipPrefs.hidden = false; savePip(); });
  window.addEventListener("resize", applyPipSize);
  // drag the label bar to move the preview anywhere; double-click it to send it back to the corner
  const lab = document.querySelector("#pip .pipLabel");
  lab.title = "Drag to move · double-click to put it back";
  lab.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    try { lab.setPointerCapture(e.pointerId); } catch {}
    const r0 = $("pip").getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top;
    document.body.classList.add("pipMoving");
    const move = (ev) => { pipPrefs.x = ev.clientX - dx; pipPrefs.y = ev.clientY - dy; applyPipSize(); };
    const up = () => { lab.removeEventListener("pointermove", move); lab.removeEventListener("pointerup", up); lab.removeEventListener("pointercancel", up); document.body.classList.remove("pipMoving"); savePip(); };
    lab.addEventListener("pointermove", move);
    lab.addEventListener("pointerup", up);
    lab.addEventListener("pointercancel", up);
  });
  lab.addEventListener("dblclick", (e) => { if (e.target.closest("button")) return; pipPrefs.x = pipPrefs.y = null; applyPipSize(); savePip(); });
  const grip = document.querySelector("#pip .pipGrip");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const r0 = $("pip").getBoundingClientRect(), x0 = e.clientX, w0 = r0.width;
    const move = (ev) => {
      pipPrefs.w = Math.max(240, Math.min(pipMaxW(), w0 + (x0 - ev.clientX)));
      if (pipPrefs.x != null) { // moved by hand: the opposite (bottom-right) corner stays put while the size changes
        const w1 = Math.max(240, Math.min(pipMaxW(), pipPrefs.w));
        pipPrefs.x = r0.right - w1;
        pipPrefs.y = r0.bottom - Math.round((w1 * 9) / 16);
      }
      applyPipSize();
    };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); savePip(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}
function updateAuthorAids() {
  const box = $("coords"), pip = $("pip");
  // coordinates (every few frames is plenty)
  if (box.hidden) box.hidden = false;
  if (++aidTick % 4 === 0) {
    const p = camera.position;
    _pipE.setFromQuaternion(camera.quaternion, "YXZ");
    const f = (v) => (v < 0 ? "" : " ") + v.toFixed(2);
    box.innerHTML = "<i>world </i>x" + f(p.x) + "  y" + f(p.y) + "  z" + f(p.z) + "\n<i>splat </i>x" + f(p.x) + "  y" + f(-p.z) + "  z" + f(p.y) +
      "\n<i>look  </i>yaw " + THREE.MathUtils.radToDeg(_pipE.y).toFixed(0) + "°  pitch " + THREE.MathUtils.radToDeg(_pipE.x).toFixed(0) + "°";
  }
  // preview of the selected point
  const show = curve && mode === "free" && selected >= 0 && wpT[selected] != null;
  const open = show && !pipPrefs.hidden;
  if (pip.hidden === open) pip.hidden = !open;
  const chip = $("pipChip");
  const wantChip = show && pipPrefs.hidden;
  if (chip.hidden === wantChip) chip.hidden = !wantChip;
  if (!open) return;
  const r = pip.getBoundingClientRect();
  samplePathT(wpT[selected], _pipP, _pipQ);
  pipCam.position.copy(_pipP);
  pipCam.quaternion.copy(_pipQ);
  pipCam.fov = camera.fov;
  pipCam.aspect = r.width / r.height;
  pipCam.updateProjectionMatrix();
  pipCam.updateMatrixWorld(true);
  pip.querySelector(".pipTitle").textContent = "Point " + (selected + 1) + " · how the tour sees it";
  const full = renderer.getSize(new THREE.Vector2());
  const vx = r.left, vy = full.y - r.bottom;
  renderer.setScissorTest(true);
  renderer.setScissor(vx, vy, r.width, r.height);
  renderer.setViewport(vx, vy, r.width, r.height);
  renderer.clear();
  const au = spark.autoUpdate;
  spark.autoUpdate = false; // keep the splat ordering for the main view; do not re-sort for the little window
  renderer.render(scene, pipCam);
  spark.autoUpdate = au;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, full.x, full.y);
}

/* ------------------------------------------------------------------ *
 *  Go
 * ------------------------------------------------------------------ */
rebuildPath();
startPose();
const defaultStart = { p: camera.position.clone(), q: camera.quaternion.clone() };
if (curve && !AUTHOR) {
  setMode("tour");
  playing = true; // visitors: the tour starts by itself
  $("playBtn").textContent = "❚❚";
} else setMode("free");
renderer.setAnimationLoop(frame);

$("loader").classList.add("done");
if (AUTHOR) {
  hudFlash(pathData.waypoints.length ? "Loaded your saved path" : "Fly to a spot, press Space to drop a point");
}
if (!AUTHOR) {
  const pb = $("ptsBtn");
  pb.textContent = "☰ Chapters";
  pb.title = "Jump to a place";
  pb.addEventListener("click", () => {
    $("pts").hidden = !$("pts").hidden;
    pb.classList.toggle("on", !$("pts").hidden);
  });
  renderChapters();
  // Desktop: start with the Chapters list open (phones keep it closed to save room).
  if (!matchMedia("(max-width:640px), (pointer:coarse)").matches && !pb.hidden) {
    $("pts").hidden = false;
    pb.classList.add("on");
  }
}
if (AUTHOR) {
  $("coords").hidden = false;
  document.body.classList.add("author");
  const pb = $("ptsBtn");
  pb.hidden = false;
  const togglePts = () => {
    $("pts").hidden = !$("pts").hidden;
    pb.classList.toggle("on", !$("pts").hidden);
  };
  pb.addEventListener("click", togglePts);
  window.__togglePts = togglePts;
  $("pts").hidden = false;
  pb.classList.add("on");
  const eb = $("editBtn");
  eb.hidden = false;
  eb.addEventListener("click", () => setEditing(!editing));
}

/* ------------------------------------------------------------------ *
 *  Speed graph (author): speed against time. Dots sit on the points (drag up / down = how fast the camera is moving as it
 *  passes, double-click = back to automatic); bars sit between points (drag up / down = how fast that stretch is flown,
 *  which makes it take less or more time).
 * ------------------------------------------------------------------ */
const SP = { l: 8, r: 8, t: 26, b: 22 };
// Other graphs: how the camera's heading / tilt (Look) and height change over the tour. Dots sit on the points, drag up / down to edit them.
let gTab = "speed", gLo = 0, gHi = 1;
const R2D = 180 / Math.PI, _gp = new THREE.Vector3(), _gq = new THREE.Quaternion(), _ge = new THREE.Euler();
const GHELP = {
  speed: "dots: drag up / down = speed, sideways = move in time, double-click = type a value, F9 = easy ease (select several, hold Alt / ⌘ to spread them out) · click one to show its handles · handles: sideways = influence, up / down = speed, Alt / ⌘ = one side · drag the curve between points to speed up / slow down that stretch · double-click to reset · drag empty space to select several points (Shift = add)",
  look: "orange: heading (left / right) · blue: tilt (up / down) · drag a dot up / down to turn the view, sideways to move it in time · drag empty space to select several",
  height: "drag a dot up / down to raise or lower that point, sideways to move it in time · drag empty space to select several",
};
function seriesModel(tab) {
  const wps = pathData.waypoints, n = wps.length;
  if (!curve || !rotSpline || n < 2) return null;
  const N = 240, yawC = [], pitC = [], yC = [];
  let prev = null;
  for (let k = 0; k <= N; k++) {
    samplePathT(k / N, _gp, _gq);
    _ge.setFromQuaternion(_gq, "YXZ");
    let yw = _ge.y * R2D;
    if (prev !== null) { while (yw - prev > 180) yw -= 360; while (yw - prev < -180) yw += 360; }
    prev = yw;
    yawC.push(yw); pitC.push(_ge.x * R2D); yC.push(_gp.y);
  }
  const idx = (t) => Math.round(clamp(t, 0, 1) * N);
  const nodes = (fn) => wps.map((w, i) => ({ i, t: wpT[i], v: fn(w, i) }));
  if (tab === "height") return [{ key: "y", color: "#6ee7a8", unit: " m", dec: 2, curve: yC, nodes: nodes((w) => w.p[1]) }];
  const eul = (w) => _ge.setFromQuaternion(_gq.set(...w.q), "YXZ");
  return [
    { key: "yaw", color: "#ffb454", unit: "°", dec: 0, curve: yawC, nodes: nodes((w, i) => { const b = eul(w).y * R2D; return b + 360 * Math.round((yawC[idx(wpT[i])] - b) / 360); }) },
    { key: "pitch", color: "#7cc4ff", unit: "°", dec: 0, curve: pitC, nodes: nodes((w) => eul(w).x * R2D) },
  ];
}
function niceStep(span) {
  const raw = span / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function drawSeries(c, g) {
  const ser = seriesModel(gTab);
  if (!ser) { c.fillStyle = "#d8d3ca"; c.font = "12px system-ui"; c.fillText("Add at least 2 points to see this graph", 12, g.H / 2); return; }
  if (!speedDrag) {
    let lo = Infinity, hi = -Infinity;
    ser.forEach((s) => { s.curve.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }); s.nodes.forEach((nd) => { lo = Math.min(lo, nd.v); hi = Math.max(hi, nd.v); }); });
    const minSpan = gTab === "height" ? 0.6 : 30;
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const pad = (hi - lo) * 0.12;
    gLo = lo - pad; gHi = hi + pad;
  }
  const X = (t) => g.x0 + (g.x1 - g.x0) * t, Y = (v) => g.y0 - ((v - gLo) / (gHi - gLo)) * (g.y0 - g.y1);
  c.font = "10px ui-monospace, Consolas, monospace";
  const step = niceStep(gHi - gLo);
  for (let v = Math.ceil(gLo / step) * step; v <= gHi; v += step) {
    c.strokeStyle = "#ffffff14"; c.lineWidth = 1; c.beginPath(); c.moveTo(g.x0, Y(v) + 0.5); c.lineTo(g.x1, Y(v) + 0.5); c.stroke();
    c.fillStyle = "#ffffff70"; c.fillText(+v.toFixed(2) + ser[0].unit, g.x0 + 3, Y(v) - 3);
  }
  ser[0].nodes.forEach((nd) => { c.strokeStyle = "#ffffff12"; c.beginPath(); c.moveTo(X(nd.t) + 0.5, g.y1); c.lineTo(X(nd.t) + 0.5, g.y0); c.stroke(); });
  ser.forEach((s) => {
    c.beginPath();
    s.curve.forEach((v, k) => { const x = X(k / (s.curve.length - 1)), y = Y(v); k ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = s.color; c.lineWidth = 2; c.stroke();
  });
  ser.forEach((s) => s.nodes.forEach((nd) => {
    const hot = (speedHover && speedHover.kind === "snode" && speedHover.key === s.key && speedHover.i === nd.i) || (speedDrag && speedDrag.kind === "snode" && speedDrag.key === s.key && speedDrag.i === nd.i);
    c.beginPath(); c.arc(X(nd.t), Y(nd.v), hot ? 7 : 5.5, 0, 7);
    c.fillStyle = nd.i === selected ? "#b388ff" : "#141416"; c.fill();
    c.lineWidth = 2; c.strokeStyle = s.color; c.stroke();
    if (gSel.size > 1 && gSel.has(nd.i)) { c.beginPath(); c.arc(X(nd.t), Y(nd.v), 9.5, 0, 7); c.lineWidth = 1.5; c.strokeStyle = "#fff"; c.stroke(); }
    if (hot) { c.fillStyle = "#fff"; c.fillText(nd.v.toFixed(s.dec) + s.unit, Math.min(X(nd.t) + 10, g.x1 - 50), Y(nd.v) - 10); }
  }));
  const ph = X(clamp(tourTarget, 0, 1));
  c.strokeStyle = "#ff5c8a"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(ph + 0.5, g.y1 - 6); c.lineTo(ph + 0.5, g.y0); c.stroke();
  drawMarquee(c);
  speedLast = tourTarget; speedDirty = false;
  const k = Math.round(clamp(tourTarget, 0, 1) * (ser[0].curve.length - 1));
  $("speedTotal").textContent = "now: " + ser.map((s) => (ser.length > 1 ? s.key + " " : "") + s.curve[k].toFixed(s.dec) + s.unit).join(" · ");
}
function seriesPick(e) {
  const ser = seriesModel(gTab);
  if (!ser) return null;
  const r = $("speedCv").getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, g = speedGeom();
  const X = (t) => g.x0 + (g.x1 - g.x0) * t, Y = (v) => g.y0 - ((v - gLo) / (gHi - gLo)) * (g.y0 - g.y1);
  let best = null, bd = 12;
  ser.forEach((s) => s.nodes.forEach((nd) => { const d = Math.hypot(X(nd.t) - px, Y(nd.v) - py); if (d < bd) { bd = d; best = { kind: "snode", key: s.key, i: nd.i }; } }));
  return best;
}
function setGraphTab(t) {
  gTab = t;
  [["speed", "gtSpeed"], ["look", "gtLook"], ["height", "gtHeight"]].forEach(([k, id]) => $(id).classList.toggle("on", k === t));
  $("speedHelp").textContent = GHELP[t];
  $("speedReset").hidden = t !== "speed";
  speedHover = null;
  closeValBox();
  speedDirty = true;
  drawSpeed();
}
function speedGeom() {
  const cv = $("speedCv");
  const W = cv.clientWidth, H = cv.clientHeight;
  return { W, H, x0: SP.l, x1: W - SP.r, y0: H - SP.b, y1: SP.t };
}
function speedModel() {
  const wps = pathData.waypoints, n = wps.length;
  if (!curve || n < 2) return null;
  const len = curve.getLength(), dur = Math.max(pathData.duration, 1);
  const at = (x) => {
    const e = 0.0025, a = Math.max(0, x - e), b = Math.min(1, x + e);
    return ((tlToU(b) - tlToU(a)) / Math.max(b - a, 1e-9)) * (len / dur);
  };
  const k = len / dur;
  // dots and handles show the speed the camera really has there (what the curve does), not the value asked for, so they never float off it
  const nodes = wpT.map((t, i) => {
    const hr = i < n - 1 ? wpT[i + 1] - wpT[i] : 0, hl = i > 0 ? wpT[i] - wpT[i - 1] : 0;
    const bo = i < n - 1 ? segB[i] : null, bi = i > 0 ? segB[i - 1] : null;
    const so = bo && bo[8] * hr > 1e-9 ? ((bo[5] - bo[4]) / (bo[8] * hr)) * k : null;
    const si = bi && bi[9] * hl > 1e-9 ? ((bi[7] - bi[6]) / (bi[9] * hl)) * k : null;
    return { i, t, v: so ?? si ?? 0, vi: si ?? so ?? 0, hr, hl, io: bo ? bo[8] : 0, ii: bi ? bi[9] : 0 };
  });
  const segs = [];
  for (let i = 0; i < n - 1; i++) {
    const L = (wpU[i + 1] - wpU[i]) * len, T = (wpT[i + 1] - wpT[i]) * dur;
    segs.push({ i, t0: wpT[i], t1: wpT[i + 1], L, T, v: L / Math.max(T, 1e-6) });
  }
  return { len, dur, at, nodes, segs };
}
function speedYScale(m) {
  let mx = 0.5;
  for (let k = 0; k <= 200; k++) mx = Math.max(mx, m.at(k / 200));
  m.nodes.forEach((n) => (mx = Math.max(mx, n.v, n.vi)));
  m.segs.forEach((s) => (mx = Math.max(mx, s.v)));
  return Math.ceil(mx * 1.2 * 2) / 2;
}
// the dots of the current graph in canvas pixels (for the selection box)
function graphNodeSpots() {
  const g = speedGeom(), X = (t) => g.x0 + (g.x1 - g.x0) * t, out = [];
  if (gTab === "speed") {
    const m = speedModel();
    if (!m) return out;
    const Y = (v) => g.y0 - (g.y0 - g.y1) * Math.min(v / speedYMax, 1.02);
    m.nodes.forEach((n) => out.push({ i: n.i, x: X(n.t), y: Y(n.v) }));
  } else {
    const ser = seriesModel(gTab);
    if (!ser) return out;
    const Y = (v) => g.y0 - ((v - gLo) / (gHi - gLo)) * (g.y0 - g.y1);
    ser.forEach((s) => s.nodes.forEach((nd) => out.push({ i: nd.i, x: X(nd.t), y: Y(nd.v) })));
  }
  return out;
}
// values of every dot as a drag starts, so a group of selected dots moves together by the same amount
function graphBase(hit) {
  const base = {};
  if (hit.kind === "node") speedModel().nodes.forEach((n) => (base[n.i] = n.v));
  else seriesModel(gTab).find((x) => x.key === hit.key).nodes.forEach((nd) => (base[nd.i] = nd.v));
  return base;
}
function drawMarquee(c) {
  const d = speedDrag;
  if (!d || d.kind !== "marquee" || !d.moved) return;
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
  c.fillStyle = "#b388ff22"; c.fillRect(x, y, w, h);
  c.strokeStyle = "#b388ff"; c.lineWidth = 1; c.setLineDash([4, 3]); c.strokeRect(x + 0.5, y + 0.5, w, h); c.setLineDash([]);
}
function drawSpeed() {
  if (!speedOn || !$("speedPanel") || !document.body.classList.contains("editing")) return;
  const cv = $("speedCv"), m = gTab === "speed" ? speedModel() : null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), g = speedGeom();
  if (!g.W || !g.H) return;
  if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.H * dpr)) { cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.H * dpr); }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, g.W, g.H);
  if (gTab !== "speed") return drawSeries(c, g);
  if (!m) { c.fillStyle = "#d8d3ca"; c.font = "12px system-ui"; c.fillText("Add at least 2 points to see speed", 12, g.H / 2); return; }
  if (!speedDrag) speedYMax = speedYScale(m);
  const X = (t) => g.x0 + (g.x1 - g.x0) * t, Y = (v) => g.y0 - (g.y0 - g.y1) * Math.min(v / speedYMax, 1.02);
  c.font = "10px ui-monospace, Consolas, monospace";
  // grid + labels
  const step = speedYMax > 4 ? 1 : 0.5;
  c.lineWidth = 1;
  for (let v = 0; v <= speedYMax + 1e-6; v += step) {
    c.strokeStyle = "#ffffff14"; c.beginPath(); c.moveTo(g.x0, Y(v) + 0.5); c.lineTo(g.x1, Y(v) + 0.5); c.stroke();
    c.fillStyle = "#ffffff70"; c.fillText(v.toFixed(v % 1 ? 1 : 0) + " m/s", g.x0 + 3, Y(v) - 3);
  }
  // chapter / point guides
  m.nodes.forEach((n) => { c.strokeStyle = "#ffffff12"; c.beginPath(); c.moveTo(X(n.t) + 0.5, g.y1); c.lineTo(X(n.t) + 0.5, g.y0); c.stroke(); });
  // the speed curve itself
  c.beginPath();
  for (let k = 0; k <= 240; k++) { const t = k / 240, x = X(t), y = Y(Math.max(m.at(t), 0)); k ? c.lineTo(x, y) : c.moveTo(x, y); }
  c.strokeStyle = "#ffb454"; c.lineWidth = 2; c.stroke();
  c.lineTo(X(1), g.y0); c.lineTo(X(0), g.y0); c.closePath(); c.fillStyle = "#ffb45422"; c.fill();
  // hovering or dragging the curve between two points: that stretch is shaded, with its average speed and time
  m.segs.forEach((s) => {
    const hot = (speedHover && speedHover.kind === "seg" && speedHover.i === s.i) || (speedDrag && speedDrag.kind === "seg" && speedDrag.i === s.i);
    if (!hot) return;
    c.beginPath();
    for (let k = 0; k <= 60; k++) { const t = s.t0 + ((s.t1 - s.t0) * k) / 60, x = X(t), y = Y(Math.max(m.at(t), 0)); k ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.lineTo(X(s.t1), g.y0); c.lineTo(X(s.t0), g.y0); c.closePath(); c.fillStyle = "#ffffff26"; c.fill();
    c.fillStyle = "#fff"; c.fillText("avg " + s.v.toFixed(2) + " m/s · " + s.T.toFixed(1) + " s", Math.max(g.x0 + 4, Math.min(X((s.t0 + s.t1) / 2) - 50, g.x1 - 120)), g.y1 - 8);
  });
  // handles of the selected point (like After Effects): drag sideways = influence, up / down = speed
  const sn = m.nodes[selected];
  if (sn) {
    const hs = [];
    if (sn.i < m.nodes.length - 1) hs.push({ kind: "hout", x: sn.t + sn.io * sn.hr, v: sn.v });
    if (sn.i > 0) hs.push({ kind: "hin", x: sn.t - sn.ii * sn.hl, v: sn.vi });
    hs.forEach((h) => {
      const hot = (speedHover && speedHover.kind === h.kind) || (speedDrag && speedDrag.kind === h.kind);
      c.strokeStyle = "#b388ff"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(sn.t), Y(sn.v)); c.lineTo(X(h.x), Y(h.v)); c.stroke();
      c.beginPath(); c.arc(X(h.x), Y(h.v), hot ? 6 : 4.5, 0, 7); c.fillStyle = "#b388ff"; c.fill(); c.lineWidth = 1.5; c.strokeStyle = "#141416"; c.stroke();
      if (hot) { c.fillStyle = "#fff"; c.fillText(h.v.toFixed(2) + " m/s · " + Math.round((h.kind === "hout" ? sn.io : sn.ii) * 100) + "%", X(h.x) + 9, Y(h.v) - 9); }
    });
  }
  // point dots (speed as the camera passes the point)
  m.nodes.forEach((n) => {
    const w = pathData.waypoints[n.i], hot = (speedHover && speedHover.kind === "node" && speedHover.i === n.i) || (speedDrag && speedDrag.kind === "node" && speedDrag.i === n.i);
    c.beginPath(); c.arc(X(n.t), Y(n.v), hot ? 7 : 5.5, 0, 7);
    c.fillStyle = w.v != null || w.io != null || w.ii != null ? "#6ee7a8" : n.i === selected ? "#b388ff" : "#141416"; c.fill();
    c.lineWidth = 2; c.strokeStyle = w.v != null ? "#141416" : "#6ee7a8"; c.stroke();
    if (gSel.size > 1 && gSel.has(n.i)) { c.beginPath(); c.arc(X(n.t), Y(n.v), 9.5, 0, 7); c.lineWidth = 1.5; c.strokeStyle = "#fff"; c.stroke(); }
    if (hot) { c.fillStyle = "#fff"; c.fillText(n.v.toFixed(2) + " m/s" + (w.v != null ? "" : " · auto"), Math.min(X(n.t) + 10, g.x1 - 80), Y(n.v) - 10); }
  });
  // playhead
  const ph = X(clamp(tourTarget, 0, 1));
  c.strokeStyle = "#ff5c8a"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(ph + 0.5, g.y1 - 6); c.lineTo(ph + 0.5, g.y0); c.stroke();
  drawMarquee(c);
  speedLast = tourTarget; speedDirty = false;
  $("speedTotal").textContent = "total " + fmtT(m.dur) + " · length " + m.len.toFixed(1) + " m";
}
function speedPick(e) {
  if (gTab !== "speed") return seriesPick(e);
  const m = speedModel();
  if (!m) return null;
  const r = $("speedCv").getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, g = speedGeom();
  const X = (t) => g.x0 + (g.x1 - g.x0) * t, Y = (v) => g.y0 - (g.y0 - g.y1) * Math.min(v / speedYMax, 1.02);
  let best = null, bd = 12;
  const sn = m.nodes[selected];
  if (sn) {
    const hs = [];
    if (sn.i < m.nodes.length - 1) hs.push({ kind: "hout", i: sn.i, x: sn.t + sn.io * sn.hr, v: sn.v });
    if (sn.i > 0) hs.push({ kind: "hin", i: sn.i, x: sn.t - sn.ii * sn.hl, v: sn.vi });
    hs.forEach((h) => { const d = Math.hypot(X(h.x) - px, Y(h.v) - py); if (d < bd) { bd = d; best = { kind: h.kind, i: h.i }; } });
    if (best) return best;
  }
  bd = 12;
  m.nodes.forEach((n) => { const d = Math.hypot(X(n.t) - px, Y(n.v) - py); if (d < bd) { bd = d; best = { kind: "node", i: n.i }; } });
  if (best) return best;
  bd = 10;
  // the curve itself between two points: drag it up / down to speed up or slow down that stretch
  const xt = (px - g.x0) / (g.x1 - g.x0);
  m.segs.forEach((s) => {
    if (xt < s.t0 || xt > s.t1) return;
    const d = Math.abs(Y(Math.max(m.at(xt), 0)) - py);
    if (d < bd) { bd = d; best = { kind: "seg", i: s.i }; }
  });
  return best;
}
function seriesSetFromY(hit, e) {
  const r = $("speedCv").getBoundingClientRect(), g = speedGeom();
  const v = gLo + ((g.y0 - (e.clientY - r.top)) / (g.y0 - g.y1)) * (gHi - gLo);
  const apply = (w, val) => {
    if (hit.key === "y") w.p[1] = +val.toFixed(3);
    else {
      _ge.setFromQuaternion(_gq.set(...w.q), "YXZ");
      if (hit.key === "yaw") _ge.y = val / R2D;
      else _ge.x = clamp(val, -85, 85) / R2D;
      _ge.z = 0;
      w.q = _gq.setFromEuler(_ge).toArray().map((x) => +x.toFixed(6));
    }
  };
  if (speedDrag.group && speedDrag.group.length > 1) {
    const dv = v - speedDrag.base[hit.i];
    speedDrag.group.forEach((i) => apply(pathData.waypoints[i], speedDrag.base[i] + dv));
  } else apply(pathData.waypoints[hit.i], v);
  rebuildPath();
}
// sideways drag of dots = move those points in time. Several selected: they move together, or with Alt / Cmd they spread out / squeeze in.
function speedTimeFromX(d, e) {
  const g = speedGeom(), wps = pathData.waypoints, n = wps.length;
  const idx = (d.group && d.group.length > 1 ? d.group : [d.i]).filter((i) => i > 0 && i < n - 1).sort((a, b) => a - b);
  if (!idx.length) return hudFlash("The first and last points stay at the start and the end");
  const dt = (e.clientX - d.sx) / (g.x1 - g.x0);
  const c = d.tBase[idx[0]], span = d.tBase[idx[idx.length - 1]] - c;
  const scale = d.spread && idx.length > 1 ? Math.max(0.1, 1 + dt / Math.max(span, 0.02)) : null;
  idx.forEach((i) => {
    const t = scale != null ? c + (d.tBase[i] - c) * scale : d.tBase[i] + dt;
    wps[i].t = +clamp(t, T_GAP * i, 1 - T_GAP * (n - 1 - i)).toFixed(4);
  });
  rebuildPath();
}
function speedSetFromY(hit, e) {
  if (hit.kind === "snode") return seriesSetFromY(hit, e);
  const r = $("speedCv").getBoundingClientRect(), g = speedGeom();
  const v = Math.max(0, ((g.y0 - (e.clientY - r.top)) / (g.y0 - g.y1)) * speedYMax);
  const wps = pathData.waypoints;
  if (hit.kind === "hout" || hit.kind === "hin") {
    const w = wps[hit.i], out = hit.kind === "hout", vv = +Math.max(v, 0.02).toFixed(3);
    // sideways = influence (how far the ease reaches along the stretch)
    const tx = (e.clientX - r.left - g.x0) / (g.x1 - g.x0);
    const hseg = out ? speedDrag.hr : speedDrag.hl;
    if (hseg > 0) {
      const infl = +clamp(out ? (tx - wpT[hit.i]) / hseg : (wpT[hit.i] - tx) / hseg, 0.02, 0.95).toFixed(3);
      if (out) w.io = infl; else w.ii = infl;
    }
    if (speedDrag.solo) { // Alt / Cmd: only this side's speed moves, the other keeps what it had
      if (w.v == null) w.v = +speedDrag.v0.toFixed(3);
      if (w.vb == null) w.vb = +speedDrag.vi0.toFixed(3);
      if (out) w.v = vv; else w.vb = vv;
    } else { w.v = vv; delete w.vb; }
  } else if (hit.kind === "node") {
    if (speedDrag.group && speedDrag.group.length > 1) {
      const dv = v - speedDrag.base[hit.i];
      speedDrag.group.forEach((i) => { wps[i].v = +Math.max(speedDrag.base[i] + dv, 0.02).toFixed(3); delete wps[i].vb; });
    } else {
      wps[hit.i].v = +Math.max(v, 0.02).toFixed(3);
      delete wps[hit.i].vb;
    }
  } else {
    // a stretch's speed sets how long it takes; the other stretches keep their own times
    const T = speedDrag.T.slice();
    T[hit.i] = Math.max((speedDrag.T[hit.i] * speedDrag.vDown) / Math.max(v, 0.08), 0.4); // relative: grabbing the curve does not make it jump
    const total = T.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < T.length - 1; k++) { acc += T[k]; wps[k + 1].t = +(acc / total).toFixed(4); }
    pathData.duration = +total.toFixed(1);
  }
  rebuildPath();
}
// Double-click a dot: type exact numbers instead of dragging. An in-page box (window.prompt() does not work in the Claude pane).
let valBox = null;
// After Effects interpolation presets on the speed graph: Easy ease (F9), Easy ease in (Shift+F9), Easy ease out (Ctrl/Cmd+Shift+F9), Linear
function applyInterp(idx, kind) {
  const wps = pathData.waypoints, n = wps.length, m = speedModel();
  if (!m) return;
  const F = 0.02; // a tiny speed instead of a dead stop, so the curve stays well-behaved
  idx.forEach((i) => {
    const w = wps[i], nd = m.nodes[i], curOut = +nd.v.toFixed(3), curIn = +nd.vi.toFixed(3);
    if (kind === "ease") { w.v = F; delete w.vb; w.io = w.ii = 0.333; }
    else if (kind === "easein") { if (i === 0) return; w.v = w.v ?? curOut; w.vb = F; w.ii = 0.333; }
    else if (kind === "easeout") { if (i === n - 1) return; w.vb = w.vb ?? w.v ?? curIn; w.v = F; w.io = 0.333; }
    else if (kind === "linear") {
      const sOut = i < n - 1 ? m.segs[i].v : null, sIn = i > 0 ? m.segs[i - 1].v : null;
      w.v = +(sOut ?? sIn).toFixed(3); w.vb = +(sIn ?? sOut).toFixed(3);
      if (Math.abs(w.v - w.vb) < 1e-6) delete w.vb;
      w.io = w.ii = 0.333;
    }
  });
  save(); rebuildPath(); speedDirty = true;
  hudFlash({ ease: "Easy ease", easein: "Easy ease in", easeout: "Easy ease out", linear: "Linear" }[kind] + (idx.length > 1 ? " · " + idx.length + " points" : ""));
}
window.addEventListener("keydown", (e) => {
  if (!AUTHOR || !speedOn || gTab !== "speed" || e.key !== "F9" || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const idx = gSel.size ? [...gSel] : selected >= 0 ? [selected] : [];
  if (!idx.length) return hudFlash("Select a point first");
  e.preventDefault();
  applyInterp(idx, e.shiftKey ? (e.ctrlKey || e.metaKey ? "easeout" : "easein") : "ease");
});
function closeValBox() { if (valBox) valBox.hidden = true; }
function openValBox(h, e) {
  const wps = pathData.waypoints, n = wps.length, i = h.i, w = wps[i], dur = Math.max(pathData.duration, 1);
  if (!valBox) {
    valBox = document.createElement("div");
    valBox.id = "valBox";
    valBox.style.cssText = "position:fixed;z-index:6;padding:10px 12px;border-radius:10px;background:#141416f7;border:1px solid #ffffff33;color:#f3efe8;font:12px system-ui;backdrop-filter:blur(14px);box-shadow:0 8px 28px #0008;min-width:170px";
    document.body.appendChild(valBox);
    valBox.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") closeValBox(); });
    valBox.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }
  const fields = [];
  if (gTab === "speed") {
    // same as After Effects' Keyframe Velocity box: speed and influence for the incoming and the outgoing side
    const nd = speedModel().nodes[i];
    if (i > 0) { fields.push({ k: "vi", label: "Speed in (m/s)", val: nd.vi, dec: 2 }); fields.push({ k: "ii", label: "Influence in (%)", val: nd.ii * 100, dec: 1 }); }
    if (i < n - 1) { fields.push({ k: "vo", label: "Speed out (m/s)", val: nd.v, dec: 2 }); fields.push({ k: "io", label: "Influence out (%)", val: nd.io * 100, dec: 1 }); }
  }
  else if (gTab === "look") {
    const ser = seriesModel("look");
    ser.forEach((sr) => fields.push({ k: sr.key, label: sr.key === "yaw" ? "Heading (°)" : "Tilt (°)", val: sr.nodes[i].v, dec: 1 }));
  } else fields.push({ k: "y", label: "Height Y (m)", val: w.p[1], dec: 2 });
  // exact position in the scene (metres): X and Z across the floor, Y up
  fields.push({ k: "x", label: "Position X (m)", val: w.p[0], dec: 2 });
  if (gTab !== "height") fields.push({ k: "y", label: "Position Y (m)", val: w.p[1], dec: 2 });
  fields.push({ k: "z", label: "Position Z (m)", val: w.p[2], dec: 2 });
  if (i > 0 && i < n - 1) fields.push({ k: "t", label: "Time (s)", val: wpT[i] * dur, dec: 1 });
  const grp = gSel.size > 1 && gSel.has(i) ? [...gSel] : [i];
  valBox.innerHTML = "<div style='opacity:.7;margin-bottom:6px'>Point " + (i + 1) + (grp.length > 1 ? " + " + (grp.length - 1) + " selected" : "") + "</div>" +
    fields.map((f) => "<label style='display:flex;justify-content:space-between;align-items:center;gap:10px;margin:4px 0'>" + f.label + "<input data-k='" + f.k + "' type='number' step='any' value='" + f.val.toFixed(f.dec) + "' style='width:76px;height:26px;border-radius:6px;border:1px solid #ffffff2a;background:#0e0e10;color:#f3efe8;font-size:13px;padding:0 6px'></label>").join("") +
    "<div style='display:flex;gap:6px;margin-top:8px'><button data-a='ok' style='flex:1;height:26px;border-radius:6px;border:0;background:#f3efe8;color:#141416;font-weight:600;cursor:pointer'>Set</button>" +
    (gTab === "speed" ? "<button data-a='auto' style='height:26px;border-radius:6px;border:1px solid #ffffff33;background:none;color:#f3efe8;cursor:pointer'>Auto</button>" : "") +
    "<button data-a='x' style='height:26px;border-radius:6px;border:1px solid #ffffff33;background:none;color:#f3efe8;cursor:pointer'>✕</button></div>";
  const ins = [...valBox.querySelectorAll("input")];
  const done = (auto) => {
    if (auto) { grp.forEach((j) => { const x = wps[j]; delete x.v; delete x.vb; delete x.io; delete x.ii; }); save(); rebuildPath(); closeValBox(); return hudFlash("Back to automatic"); }
    ins.forEach((inp, q) => {
      const f = fields[q], val = parseFloat(inp.value);
      if (!isFinite(val) || Math.abs(val - +f.val.toFixed(f.dec)) < 1e-9) return;
      if (f.k === "t") wps[i].t = +clamp(val / dur, T_GAP * i, 1 - T_GAP * (n - 1 - i)).toFixed(4);
      else grp.forEach((j) => {
        const x = wps[j];
        if (f.k === "vo" || f.k === "vi") {
          const nd0 = speedModel().nodes[j], sv = (k) => +Math.max(k, 0).toFixed(3);
          const out = f.k === "vo" ? sv(val) : x.v ?? +nd0.v.toFixed(3), inn = f.k === "vi" ? sv(val) : x.vb ?? x.v ?? +nd0.vi.toFixed(3);
          x.v = out; if (Math.abs(inn - out) < 1e-6) delete x.vb; else x.vb = inn;
        } else if (f.k === "io") x.io = +clamp(val / 100, 0.02, 0.95).toFixed(3);
        else if (f.k === "ii") x.ii = +clamp(val / 100, 0.02, 0.95).toFixed(3);
        else if (f.k === "x") x.p[0] = +val.toFixed(3);
        else if (f.k === "y") x.p[1] = +val.toFixed(3);
        else if (f.k === "z") x.p[2] = +val.toFixed(3);
        else {
          _ge.setFromQuaternion(_gq.set(...x.q), "YXZ");
          if (f.k === "yaw") _ge.y = val / R2D; else _ge.x = clamp(val, -85, 85) / R2D;
          _ge.z = 0;
          x.q = _gq.setFromEuler(_ge).toArray().map((c) => +c.toFixed(6));
        }
      });
    });
    save(); rebuildPath(); speedDirty = true; closeValBox();
  };
  if (gTab === "speed") {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:8px";
    [["ease", "Easy ease"], ["easein", "Ease in"], ["easeout", "Ease out"], ["linear", "Linear"]].forEach(([k, t]) => row.insertAdjacentHTML("beforeend", "<button data-a='i:" + k + "' style='height:24px;padding:0 8px;border-radius:6px;border:1px solid #ffffff33;background:none;color:#f3efe8;cursor:pointer;font-size:11px'>" + t + "</button>"));
    valBox.appendChild(row);
  }
  valBox.onclick = (ev) => { const a = ev.target.closest("button")?.dataset.a; if (a === "ok") done(false); else if (a === "auto") done(true); else if (a === "x") closeValBox(); else if (a && a.startsWith("i:")) { applyInterp(grp, a.slice(2)); closeValBox(); } };
  ins.forEach((inp) => inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(false); }));
  valBox.hidden = false;
  valBox.style.left = Math.max(8, Math.min(e.clientX - 90, innerWidth - 200)) + "px";
  valBox.style.top = Math.max(8, e.clientY - valBox.offsetHeight - 16) + "px";
  ins[0].focus(); ins[0].select();
}
// the graph panel is as tall as you like (drag its top edge), like After Effects' graph editor
(function () {
  if (!AUTHOR) return;
  try { const v = +localStorage.getItem("china26-gph"); if (v >= 160) document.documentElement.style.setProperty("--gph", v + "px"); } catch {}
  const panel = document.getElementById("speedPanel");
  if (!panel) return;
  const grip = document.createElement("div");
  grip.id = "speedGrip";
  grip.title = "Drag to make the graph taller or shorter";
  panel.prepend(grip);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = panel.getBoundingClientRect().height;
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      const h = Math.round(Math.max(160, Math.min(innerHeight * 0.7, h0 + (y0 - ev.clientY))));
      document.documentElement.style.setProperty("--gph", h + "px");
      speedDirty = true;
    };
    const up = () => { grip.removeEventListener("pointermove", mv); grip.removeEventListener("pointerup", up); try { localStorage.setItem("china26-gph", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--gph"))); } catch {} };
    grip.addEventListener("pointermove", mv);
    grip.addEventListener("pointerup", up);
  });
})();
function setSpeedPanel(on) {
  speedOn = !!on;
  document.body.classList.toggle("speedon", speedOn);
  $("speedBtn").classList.toggle("on", speedOn);
  $("speedPanel").hidden = !speedOn;
  speedDirty = true;
  if (speedOn) requestAnimationFrame(drawSpeed);
}
if (AUTHOR) {
  $("speedBtn").hidden = false;
  $("speedBtn").addEventListener("click", () => setSpeedPanel(!speedOn));
  $("speedX").addEventListener("click", () => setSpeedPanel(false));
  $("gtSpeed").addEventListener("click", () => setGraphTab("speed"));
  $("gtLook").addEventListener("click", () => setGraphTab("look"));
  $("gtHeight").addEventListener("click", () => setGraphTab("height"));
  $("speedReset").addEventListener("click", () => {
    let any = false;
    pathData.waypoints.forEach((w) => { if (w.v != null || w.vb != null || w.io != null || w.ii != null) { delete w.v; delete w.vb; delete w.io; delete w.ii; any = true; } });
    if (any) { save(); rebuildPath(); hudFlash("All point speeds and handles back to automatic"); } else hudFlash("Nothing to reset");
  });
  const cv = $("speedCv");
  cv.addEventListener("pointerdown", (e) => {
    const hit = speedPick(e);
    const rr0 = cv.getBoundingClientRect(), cx = e.clientX - rr0.left, cy = e.clientY - rr0.top;
    if (!hit) {
      // empty space: drag a box to select several points
      e.preventDefault();
      speedDrag = { kind: "marquee", x0: cx, y0: cy, x1: cx, y1: cy, add: e.shiftKey, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    e.preventDefault();
    if ((hit.kind === "node" || hit.kind === "snode") && e.shiftKey) {
      // Shift + click a dot: add it to / take it off the selection
      if (!gSel.size && selected >= 0) gSel.add(selected);
      if (gSel.has(hit.i)) gSel.delete(hit.i); else gSel.add(hit.i);
      speedDirty = true;
      return;
    }
    const m = speedModel();
    const nd = m.nodes[hit.i];
    speedDrag = { ...hit, sx: e.clientX, sy: e.clientY, tBase: wpT.slice(), spread: e.altKey || e.metaKey, T: m.segs.map((s) => s.T), L: m.segs.map((s) => s.L), moved: false, solo: e.altKey || e.metaKey, hr: nd ? nd.hr : 0, hl: nd ? nd.hl : 0, v0: nd ? nd.v : 0, vi0: nd ? nd.vi : 0 };
    try { cv.setPointerCapture(e.pointerId); } catch {}
    if (hit.kind === "seg") { const rr = cv.getBoundingClientRect(), gg = speedGeom(); speedDrag.vDown = Math.max(0.05, ((gg.y0 - (e.clientY - rr.top)) / (gg.y0 - gg.y1)) * speedYMax); }
    if (hit.kind === "node" || hit.kind === "snode") {
      if (!gSel.has(hit.i)) gSel = new Set([hit.i]);
      if (gSel.size > 1) { speedDrag.group = [...gSel]; speedDrag.base = graphBase(hit); }
      selectPoint(hit.i);
    }
    if (hit.kind === "hout" || hit.kind === "hin") hudFlash(speedDrag.solo ? "One side only" : "Sideways = influence · up / down = speed (Alt / ⌘ = one side only)");
    speedDirty = true;
  });
  cv.addEventListener("pointermove", (e) => {
    if (speedDrag && speedDrag.kind === "marquee") {
      const rr = cv.getBoundingClientRect();
      speedDrag.x1 = e.clientX - rr.left; speedDrag.y1 = e.clientY - rr.top;
      if (Math.hypot(speedDrag.x1 - speedDrag.x0, speedDrag.y1 - speedDrag.y0) > 4) speedDrag.moved = true;
      speedDirty = true;
      return;
    }
    if (speedDrag && (speedDrag.kind === "node" || speedDrag.kind === "snode")) {
      // a dot moves one way at a time: sideways = in time, up / down = its value
      if (!speedDrag.axis) {
        const dx = e.clientX - speedDrag.sx, dy = e.clientY - speedDrag.sy;
        if (Math.hypot(dx, dy) < 5) return;
        speedDrag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      speedDrag.moved = true;
      if (speedDrag.axis === "x") speedTimeFromX(speedDrag, e); else speedSetFromY(speedDrag, e);
      return;
    }
    if (speedDrag) { speedDrag.moved = true; speedSetFromY(speedDrag, e); return; }
    const h = speedPick(e);
    const same = (!h && !speedHover) || (h && speedHover && h.kind === speedHover.kind && h.i === speedHover.i && h.key === speedHover.key);
    if (!same) { speedHover = h; speedDirty = true; }
    cv.style.cursor = h ? (h.kind === "node" || h.kind === "snode" ? "move" : "ns-resize") : "default";
  });
  const up = () => {
    const d = speedDrag;
    if (d && d.kind === "marquee") {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (d.moved) {
        const hits = [...new Set(graphNodeSpots().filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map((p) => p.i))];
        gSel = d.add ? new Set([...gSel, ...hits]) : new Set(hits);
        if (hits.length) selectPoint(hits[0]);
        hudFlash(hits.length ? hits.length + (hits.length === 1 ? " point selected" : " points selected · drag any of them to move them together") : "No points in the box");
      } else if (!d.add) gSel = new Set();
    } else if (d && d.moved) save();
    speedDrag = null;
    speedDirty = true;
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointerleave", () => { if (!speedDrag && speedHover) { speedHover = null; speedDirty = true; } });
  cv.addEventListener("dblclick", (e) => {
    const h = speedPick(e);
    if (!h) return;
    const w = pathData.waypoints[h.i];
    if (h.kind === "node" || h.kind === "snode") openValBox(h, e);
    else if (h.kind === "hout" || h.kind === "hin") { delete w.io; delete w.ii; delete w.vb; delete w.v; save(); rebuildPath(); hudFlash("Handles back to automatic"); }
  });
  window.addEventListener("resize", () => { speedDirty = true; });
}

// Auto-pace: spread the points over a total time so the camera never moves or turns faster than a comfortable rate.
// Each stretch gets time for the distance it covers PLUS time for how far the view has to turn.
const PACE_SPEED = 1.1; // metres per second of travel
const PACE_TURN = 18; // degrees per second of turning
function autoPace(total) {
  const wps = pathData.waypoints, n = wps.length;
  if (!curve || n < 3) return hudFlash("Need at least 3 points to pace");
  const len = curve.getLength();
  const raw = [];
  let maxRate = 0;
  for (let i = 0; i < n - 1; i++) {
    const L = (wpU[i + 1] - wpU[i]) * len;
    const ang = (2 * Math.acos(Math.min(1, Math.abs(rotQ[i].dot(rotQ[i + 1])))) * 180) / Math.PI;
    const t0 = curve.getTangentAt(wpU[i]), t1 = curve.getTangentAt(Math.min(wpU[i + 1], 0.9999));
    const head = (Math.acos(clamp(t0.dot(t1), -1, 1)) * 180) / Math.PI; // how much the direction of travel bends
    raw.push(Math.max(L / PACE_SPEED + ang / PACE_TURN + head / (PACE_TURN * 2), 1.2));
  }
  delete wps[n - 1].t;
  const sum = raw.reduce((a, b) => a + b, 0), k = total / sum;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const T = raw[i] * k;
    const ang = (2 * Math.acos(Math.min(1, Math.abs(rotQ[i].dot(rotQ[i + 1])))) * 180) / Math.PI;
    maxRate = Math.max(maxRate, ang / T);
    acc += T;
    if (i + 1 < n - 1) wps[i + 1].t = +(acc / total).toFixed(4);
  }
  pathData.duration = +total.toFixed(1);
  save();
  rebuildPath();
  hudFlash("Paced to " + fmtT(total) + " · fastest turn " + Math.round(maxRate) + "°/s");
}
if (AUTHOR) {
  $("paceBtn").hidden = false;
  // An in-page box instead of window.prompt(), which some browsers (including the Claude pane) don't support.
  const pp = document.createElement("div");
  pp.id = "pacePanel";
  pp.hidden = true;
  pp.innerHTML = '<div>Total tour length</div><div class="pRow"><input id="paceMin" type="number" min="0" max="20" value="2" inputmode="numeric"><span>min</span><input id="paceSec" type="number" min="0" max="59" value="10" inputmode="numeric"><span>sec</span></div><div class="pRow"><button id="paceGo">Pace it</button><button id="paceX">Cancel</button></div>';
  document.body.appendChild(pp);
  const paceClose = () => { pp.hidden = true; $("paceBtn").classList.remove("on"); };
  $("paceBtn").addEventListener("click", () => {
    if (!pp.hidden) return paceClose();
    const d = Math.round(pathData.duration < 120 ? 130 : pathData.duration);
    $("paceMin").value = Math.floor(d / 60);
    $("paceSec").value = d % 60;
    pp.hidden = false;
    $("paceBtn").classList.add("on");
    $("paceMin").select();
  });
  const paceApply = () => {
    const s = (Number($("paceMin").value) || 0) * 60 + (Number($("paceSec").value) || 0);
    if (s < 20 || s > 1200) return hudFlash("Pick a length between 0:20 and 20:00");
    paceClose();
    autoPace(s);
  };
  $("paceGo").addEventListener("click", paceApply);
  $("paceX").addEventListener("click", paceClose);
  pp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") paceApply(); if (e.key === "Escape") paceClose(); });
  pp.addEventListener("keyup", (e) => e.stopPropagation());
}

// "Preview as visitor": hide every author tool and show exactly what a visitor gets (tour mode, chapters menu, plain timeline)
function setPreview(on) {
  if (!AUTHOR || preview === on) return;
  if (on && editing) setEditing(false);
  preview = on;
  const pb = $("ptsBtn");
  document.body.classList.toggle("author", !on);
  document.body.classList.toggle("previewing", on);
  $("prevBtn").textContent = on ? "✕ Exit preview" : "👁 Preview";
  $("prevBtn").classList.toggle("on", on);
  $("editBtn").hidden = on;
  $("author").hidden = on;
  pb.textContent = on ? "☰ Chapters" : "☰ Points";
  pb.classList.remove("on");
  if (on) {
    $("pts").hidden = true;
    selectPoint(-1);
    if (curve) {
      if (mode !== "tour") setMode("tour");
      tourU = tourTarget = 0;
      playing = false;
      $("playBtn").textContent = "▶";
    }
    renderChapters();
    hudFlash("Preview · this is what visitors see · Esc to exit");
  } else {
    pb.hidden = false;
    $("pts").hidden = false;
    pb.classList.add("on");
    if (mode === "tour") setMode("free");
    rebuildPath();
    hudFlash("Back to editing");
  }
  updateHud();
}
if (AUTHOR) {
  $("prevBtn").hidden = false;
  $("prevBtn").addEventListener("click", () => setPreview(!preview));
}
window.__tour = { samplePathT, autoPace, setPreview, rebuildPath, overlay, markers, diagv: () => diag, scene, renderer, camera, mesh, pathData, setMode, get mode() { return mode; }, setEditing };
