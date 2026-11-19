import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

/* ------------------------------------------------------------------ *
 *  Setup
 * ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);
const AUTHOR = params.has("author");
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const STORE_KEY = "china26-path-v1";

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

function save() {
  if (!AUTHOR) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pathData));
  } catch {}
}

/* ------------------------------------------------------------------ *
 *  Three + Spark
 * ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

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
const baseSpeed = () => diag / 40; // units per second
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
let wpU = []; // arc-length parameter of each waypoint
let pathLine = null;
const markers = new THREE.Group();
scene.add(markers);

function rebuildPath() {
  const wps = pathData.waypoints;
  curve = null;
  wpU = [];
  if (pathLine) {
    scene.remove(pathLine);
    pathLine.geometry.dispose();
    pathLine = null;
  }
  while (markers.children.length) {
    const m = markers.children.pop();
    m.geometry?.dispose();
  }
  if (wps.length >= 2) {
    const pts = wps.map((w) => new THREE.Vector3(...w.p));
    curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const per = 100;
    curve.arcLengthDivisions = (wps.length - 1) * per;
    curve.updateArcLengths();
    const lens = curve.getLengths((wps.length - 1) * per);
    const total = lens[lens.length - 1] || 1;
    wpU = wps.map((_, i) => lens[i * per] / total);
    wpU[0] = 0;
    wpU[wps.length - 1] = 1;
  }
  if (AUTHOR) {
    if (curve) {
      const g = new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(Math.max(50, wps.length * 60)));
      pathLine = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: 0xffb454, depthTest: false, transparent: true })
      );
      pathLine.renderOrder = 999;
      scene.add(pathLine);
    }
    const r = diag * 0.004;
    wps.forEach((w, i) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(r, 12, 12),
        new THREE.MeshBasicMaterial({ color: i === 0 ? 0x6ee7a8 : 0xffb454, depthTest: false })
      );
      m.position.set(...w.p);
      m.renderOrder = 1000;
      // little nose showing where the camera looks
      const q = new THREE.Quaternion(...w.q);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const nose = new THREE.Mesh(
        new THREE.SphereGeometry(r * 0.5, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
      );
      nose.position.copy(dir.multiplyScalar(r * 4));
      nose.renderOrder = 1001;
      m.add(nose);
      markers.add(m);
    });
  }
  updateHud();
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
canvas.addEventListener("pointerdown", (e) => {
  drag = { type: e.pointerType, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
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
  drag = null;
  document.body.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

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
  if (k === "r" && !e.ctrlKey && !e.metaKey) return resetView();
  if (mode === "free") {
    if (["w", "a", "s", "d", "q", "e", "shift"].includes(k)) keys.add(k);
  }
  if (AUTHOR) {
    if (k === " " && mode === "free") {
      e.preventDefault();
      addWaypoint();
      return;
    }
    if (k === "backspace") {
      e.preventDefault();
      if (e.shiftKey) pathData.waypoints = [];
      else pathData.waypoints.pop();
      save();
      rebuildPath();
      if (!curve && mode === "tour") setMode("free");
      return;
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
  pathData.waypoints.push({
    p: camera.position.toArray().map((v) => +v.toFixed(5)),
    q: camera.quaternion.toArray().map((v) => +v.toFixed(6)),
  });
  save();
  rebuildPath();
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
    return { p: p.toArray(), q: q.toArray() };
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
    samplePath(tourU, _p, _pq);
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
  }

  renderer.render(scene, camera);
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
window.__tour = { camera, mesh, pathData, setMode, get mode() { return mode; } };
