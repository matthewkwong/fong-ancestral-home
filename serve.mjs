// Tiny static server (no dependencies). Run:  node serve.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".webp": "image/webp",
  ".png": "image/png", ".jpg": "image/jpeg", ".sog": "application/octet-stream", ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
};

import { bakeFile } from "./bake.mjs";
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), "utf8")); } catch { return null; } };
const bake = { state: "idle", removed: 0, total: 0, error: "", file: "" };
let pending = null, baking = false;
function queueBake(data) { pending = data; if (!baking) runBake(); }
function runBake() {
  baking = true;
  setTimeout(() => {
    const data = pending; pending = null;
    try {
      bake.state = "working"; bake.error = "";
      const cfg = readJ("config.json") || {};
      const name = decodeURIComponent(String(cfg.splat || "").split("?")[0].split("/").pop());
      if (!name.endsWith(".spz") || !fs.existsSync(path.join(root, name))) throw new Error(name + " is not in the site folder");
      // the splat file is updated in place. The untouched original is kept once as <name>.original.spz, and every update starts from it,
      // so removing a mark brings those splats back.
      const orig = name.replace(/\.spz$/, ".original.spz");
      if (!fs.existsSync(path.join(root, orig))) fs.copyFileSync(path.join(root, name), path.join(root, orig));
      const r = bakeFile({ src: path.join(root, orig), marks: data.spheres || [], orientation: data.orientation ?? readJ("path.json")?.orientation ?? cfg.orientation ?? 0, out: path.join(root, name) });
      Object.assign(bake, { state: "done", removed: r.removed, total: r.total, file: name });
      console.log(`updated ${name}: ${r.removed} splats removed by ${data.spheres.length} marks`);
    } catch (e) { bake.state = "error"; bake.error = String(e.message || e); console.error("bake failed:", e); }
    baking = false;
    if (pending) runBake();
  }, 50);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // author tool: the Erase panel posts its marks here. They are saved as erase.json and baked into
  // the splat file (in place) right away. The untouched original is kept as <name>.original.spz.
  if (req.method === "POST" && url.pathname === "/__erase") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(path.join(root, "erase.json"), JSON.stringify(data, null, 2));
        res.writeHead(200).end("ok");
        queueBake(data);
      } catch { res.writeHead(400).end("bad json"); }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/__bake-status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(bake));
    return;
  }
  // author tool: every edit is written straight to path.json. Only accepted if the file on disk still matches the version the page was built from.
  if (req.method === "POST" && url.pathname === "/__path") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { base, data } = JSON.parse(body);
        if (!data || !Array.isArray(data.waypoints)) throw new Error("bad data");
        const target = path.join(root, "path.json");
        if (fs.existsSync(target)) {
          let disk = "";
          try { disk = JSON.stringify(JSON.parse(fs.readFileSync(target, "utf8"))); } catch {}
          if (disk && disk !== base) { res.writeHead(409).end("path.json changed on disk"); return; }
          fs.copyFileSync(target, path.join(root, "path.backup.json"));
        }
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
        fs.renameSync(tmp, target);
        res.writeHead(200).end("ok");
      } catch { res.writeHead(400).end("bad json"); }
    });
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
  const size = fs.statSync(file).size;
  const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}/   (author mode: http://localhost:${port}/?author)`));
