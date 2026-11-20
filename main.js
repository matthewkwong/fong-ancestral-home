import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

/* ------------------------------------------------------------------ *
 *  Setup
 * ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);
const AUTHOR = params.has("author");
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
if (AUTHOR) {
  try {
    pathData = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {}
}
if (!pathData) pathData = await fetchJSON("./path.json", null);
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
function tlToU(x) {
  const n = wpT.length;
  if (n < 2) return x;
  x = clamp(x, 0, 1);
  let j = 0;
  while (j < n - 2 && x > wpT[j + 1]) j++;
  const f = clamp((x - wpT[j]) / Math.max(wpT[j + 1] - wpT[j], 1e-6), 0, 1);
  return wpU[j] + f * (wpU[j + 1] - wpU[j]);
}
const T_GAP = 0.004;
let pathLine = null;
const overlay = new THREE.Scene(); // drawn after the splats, always on top
const markers = new THREE.Group();
overlay.add(markers);

let editing = false; // author: point-editing mode (drag points, add on line)
function setEditing(on) {
  editing = !!on;
  const b = $("editBtn");
  if (b) {
    b.textContent = editing ? "✓ Done editing" : "✎ Edit path";
    b.classList.toggle("on", editing);
  }
  document.body.classList.toggle("editing", editing);
  if (!editing) selectPoint(-1);
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
function jumpTo(i) {
  const wps = pathData.waypoints;
  if (!wps[i]) return;
  selectPoint(i);
  if (mode === "tour" && wpT[i] != null) {
    tourTarget = wpT[i];
    playing = false;
    $("playBtn").textContent = "▶";
  } else viewFrom(i);
}
function renderTimeline() {
  if (!AUTHOR) return;
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
  constructor(pts, hs) {
    super();
    this.pts = pts;
    this.hs = hs;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const n = this.pts.length - 1;
    const s = clamp(t, 0, 1) * n;
    const i = Math.min(Math.floor(s), n - 1);
    const f = s - i, g = 1 - f;
    const p0 = this.pts[i], p3 = this.pts[i + 1];
    const p1 = _b1.copy(p0).add(this.hs[i]);
    const p2 = _b2.copy(p3).sub(this.hs[i + 1]);
    const a = g * g * g, b = 3 * g * g * f, c = 3 * g * f * f, d = f * f * f;
    return target.set(
      a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      a * p0.z + b * p1.z + c * p2.z + d * p3.z
    );
  }
}
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();
// automatic handle for point i (used until you drag it): smooth, and scaled to the nearer neighbour so it never overshoots
function autoHandle(i, pts) {
  const n = pts.length;
  const prev = pts[Math.max(i - 1, 0)], next = pts[Math.min(i + 1, n - 1)];
  const dir = next.clone().sub(prev);
  if (dir.lengthSq() < 1e-12) return new THREE.Vector3();
  dir.normalize();
  const dl = i > 0 ? pts[i].distanceTo(pts[i - 1]) : Infinity;
  const dr = i < n - 1 ? pts[i].distanceTo(pts[i + 1]) : Infinity;
  return dir.multiplyScalar(Math.min(dl, dr) / 3);
}
function handleVecs(wps) {
  const pts = wps.map((w) => new THREE.Vector3(...w.p));
  return { pts, hs: wps.map((w, i) => (w.h ? new THREE.Vector3(...w.h) : autoHandle(i, pts))) };
}
// the two handle ends of a point (forward = +H, back = -H), for drawing and picking
function tangentEnds(i, out) {
  const wps = pathData.waypoints;
  const { pts, hs } = handleVecs(wps);
  const p = pts[i];
  out.fwd = p.clone().add(hs[i]);
  out.back = p.clone().sub(hs[i]);
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
    const { pts, hs } = handleVecs(wps);
    curve = new BezierPath(pts, hs);
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
}

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
function samplePath(u, outPos, outQuat) {
  const wps = pathData.waypoints;
  u = clamp(u, 0, 1);
  curve.getPointAt(u, outPos);
  let j = 0;
  while (j < wps.length - 2 && u > wpU[j + 1]) j++;
  const span = Math.max(wpU[j + 1] - wpU[j], 1e-6);
  const l = clamp((u - wpU[j]) / span, 0, 1);
  const e = l * l * (3 - 2 * l);
  _q0.set(...wps[j].q);
  _q1.set(...wps[j + 1].q);
  outQuat.copy(_q0).slerp(_q1, e);
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

function setMode(m) {
  if (m === "tour" && !curve) return;
  if (mode === "free" && m === "tour") {
    tourU = tourTarget = 0;
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
  if (AUTHOR && !editing && mode === "free" && e.button === 0 && pickWaypoint(e) >= 0) {
    hudFlash("Turn on ✎ Edit path (top right, or press M) to move points");
  }
  if (AUTHOR && editing && mode === "free" && e.button === 0) {
    const th = pickTangent(e);
    if (th) {
      drag.tan = th;
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
  if (AUTHOR && editing && !drag && mode === "free") canvas.style.cursor = pickTangent(e) || pickLook(e) >= 0 || pickWaypoint(e) >= 0 ? "grab" : "crosshair";
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
      w.h = v.toArray().map((x) => +x.toFixed(5));
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
    yaw -= dx * 0.003;
    pitch = clamp(pitch - dy * 0.003, -1.5, 1.5);
    setCameraFromYawPitch();
  } else {
    lookYaw = clamp(lookYaw - dx * 0.003, -1.3, 1.3);
    if (drag.type === "touch") {
      tourTarget = clamp(tourTarget - dy * 0.0018, 0, 1);
      playing = false;
    } else {
      lookPitch = clamp(lookPitch - dy * 0.003, -0.8, 0.8);
    }
  }
});
const endDrag = () => {
  if (drag) {
    if ((drag.point >= 0 || drag.look >= 0 || drag.tan) && drag.moved) save();
    // plain click on empty space = deselect
    else if (AUTHOR && drag.point < 0 && drag.look < 0 && !drag.tan && !drag.moved && selected >= 0) selectPoint(-1);
  }
  drag = null;
  document.body.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// double-click on the path line = add a point right there
canvas.addEventListener("dblclick", (e) => {
  if (!AUTHOR || !editing || mode !== "free") return;
  const th = pickTangent(e);
  if (th) {
    delete pathData.waypoints[th.i].h;
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
  if (AUTHOR && (e.ctrlKey || e.metaKey) && (k === "c" || k === "x" || k === "v")) {
    e.preventDefault();
    return clipboardOp(k, e.shiftKey);
  }
  if (AUTHOR && (e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
    e.preventDefault();
    return stepHistory(k === "y" || e.shiftKey ? 1 : -1);
  }
  if (k === "r" && !e.ctrlKey && !e.metaKey) return resetView();
  if (mode === "free") {
    if (["w", "a", "s", "d", "q", "e", "shift"].includes(k)) keys.add(k);
  }
  if (AUTHOR) {
    // Space while the pointer is over the playbar = play / pause (instead of dropping a point)
    if (k === " " && overBar && curve) {
      e.preventDefault();
      if (mode !== "tour") setMode("tour");
      togglePlay();
      return;
    }
    if (k === " " && mode === "free") {
      e.preventDefault();
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
window.addEventListener("blur", () => keys.clear());

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
}
let overBar = false;
$("ui").addEventListener("pointerenter", () => (overBar = true));
$("ui").addEventListener("pointerleave", () => (overBar = false));
$("playBtn").addEventListener("click", () => {
  if (mode !== "tour") setMode("tour");
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
  if (selected >= 0) {
    // a point is selected: slot the new one in right after it
    pathData.waypoints.splice(selected + 1, 0, wp);
    selected += 1;
  } else {
    pathData.waypoints.push(wp);
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
  $("author").hidden = false;
  $("count").textContent = n + (n === 1 ? " point" : " points");
  $("modeLabel").textContent = mode === "tour" ? "previewing" : "free fly";
}

/* ------------------------------------------------------------------ *
 *  Frame loop
 * ------------------------------------------------------------------ */
let last = performance.now();
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
    vel.lerp(wish, 1 - Math.exp(-dt * 10));
    camera.position.addScaledVector(vel, dt);
    if (GROUND.on && floorGrid) {
      const minY = floorAt(camera.position.x, camera.position.z) + clearance;
      if (camera.position.y < minY) {
        camera.position.y += (minY - camera.position.y) * Math.min(1, dt * 15);
        if (vel.y < 0) vel.y = 0;
      }
    }
  } else if (curve) {
    if (playing) {
      tourTarget = Math.min(1, tourTarget + dt / Math.max(pathData.duration, 5));
      if (tourTarget >= 1) {
        playing = false;
        $("playBtn").textContent = "▶";
      }
    }
    tourU += (tourTarget - tourU) * (1 - Math.exp(-dt * 4));
    samplePath(tlToU(tourU), _p, _pq);
    camera.position.copy(_p);
    if (!drag) {
      const k = Math.exp(-dt * 1.4);
      lookYaw *= k;
      lookPitch *= k;
    }
    _off.setFromEuler(euler.set(lookPitch, lookYaw, 0, "YXZ"));
    _tq.copy(_pq).multiply(_off);
    camera.quaternion.slerp(_tq, 1 - Math.exp(-dt * 6));
    if (document.activeElement !== $("slider")) $("slider").value = Math.round(tourTarget * 1000);
    if (AUTHOR) $("clock").textContent = fmtT(tourU * pathData.duration) + " / " + fmtT(pathData.duration);
  }

  if (AUTHOR) {
    // hide the route decorations while previewing so they do not clutter the shot
    markers.visible = mode !== "tour";
    if (pathLine) pathLine.visible = mode !== "tour";
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
  if (AUTHOR) {
    renderer.clearDepth();
    renderer.render(overlay, camera);
  }
}

/* ------------------------------------------------------------------ *
 *  Go
 * ------------------------------------------------------------------ */
rebuildPath();
startPose();
const defaultStart = { p: camera.position.clone(), q: camera.quaternion.clone() };
if (curve && !AUTHOR) setMode("tour");
else setMode("free");
renderer.setAnimationLoop(frame);

$("loader").classList.add("done");
if (AUTHOR) {
  hudFlash(pathData.waypoints.length ? "Loaded your saved path" : "Fly to a spot, press Space to drop a point");
}
if (AUTHOR) {
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
window.__tour = { overlay, markers, diagv: () => diag, scene, renderer, camera, mesh, pathData, setMode, get mode() { return mode; }, setEditing };
