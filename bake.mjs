// Removes the splats inside the erase marks from a .spz (SPZ v2/v3). Used by serve.mjs (automatic) and bake-erase.mjs (publish).
import fs from "node:fs";
import zlib from "node:zlib";

// same table as ORIENTATIONS in main.js (degrees, three.js "XYZ" euler)
const ORI = [[0, 0, 0], [180, 0, 0], [90, 0, 0], [-90, 0, 0], [0, 0, 180], [0, 180, 0]];
function rot([ax, ay, az]) {
  const d = Math.PI / 180, [a, b, c] = [ax * d, ay * d, az * d];
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
}

// marks: [{ p:[x,y,z] (world), r }]; orientation: index into ORI. Writes `out` (atomically). Returns { total, removed, per:[count per mark] }.
export function bakeFile({ src, marks, orientation = 0, out }) {
  const R = rot(ORI[orientation] || [0, 0, 0]); // world = R * file, so file = R^T * world
  const balls = marks.map((m) => ({
    c: [R[0][0] * m.p[0] + R[1][0] * m.p[1] + R[2][0] * m.p[2], R[0][1] * m.p[0] + R[1][1] * m.p[1] + R[2][1] * m.p[2], R[0][2] * m.p[0] + R[1][2] * m.p[1] + R[2][2] * m.p[2]],
    r2: m.r * m.r, n: 0,
  }));
  const buf = zlib.gunzipSync(fs.readFileSync(src));
  if (buf.readUInt32LE(0) !== 0x5053474e) throw new Error("not an SPZ file");
  const version = buf.readUInt32LE(4), N = buf.readUInt32LE(8), shDeg = buf[12], frac = buf[13];
  const shDim = [0, 3, 8, 15][shDeg], rotB = version >= 3 ? 4 : 3;
  if (shDim === undefined || version < 2 || version > 3) throw new Error("unsupported SPZ (version " + version + ", SH " + shDeg + ")");
  const sizes = [N * 9, N, N * 3, N * 3, N * rotB, N * shDim * 3];
  if (16 + sizes.reduce((a, b) => a + b, 0) !== buf.length) throw new Error("unexpected SPZ layout; left unchanged");
  const keep = new Uint8Array(N).fill(1), s = 1 / (1 << frac);
  let removed = 0;
  for (let i = 0; i < N && balls.length; i++) {
    const o = 16 + i * 9;
    let x = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16); if (x & 0x800000) x -= 0x1000000;
    let y = buf[o + 3] | (buf[o + 4] << 8) | (buf[o + 5] << 16); if (y & 0x800000) y -= 0x1000000;
    let z = buf[o + 6] | (buf[o + 7] << 8) | (buf[o + 8] << 16); if (z & 0x800000) z -= 0x1000000;
    x *= s; y *= s; z *= s;
    for (const b of balls) {
      const dx = x - b.c[0], dy = y - b.c[1], dz = z - b.c[2];
      if (dx * dx + dy * dy + dz * dz <= b.r2) { b.n++; if (keep[i]) { keep[i] = 0; removed++; } }
    }
  }
  const M = N - removed;
  const outBuf = Buffer.alloc(16 + [M * 9, M, M * 3, M * 3, M * rotB, M * shDim * 3].reduce((a, b) => a + b, 0));
  buf.copy(outBuf, 0, 0, 16);
  outBuf.writeUInt32LE(M, 8);
  let off = 16, so = 16;
  for (const size of sizes) {
    const per = size / N;
    for (let i = 0; i < N; i++) if (keep[i]) { buf.copy(outBuf, off, so + i * per, so + (i + 1) * per); off += per; }
    so += size;
  }
  const gz = zlib.gzipSync(outBuf, { level: 6 });
  if (zlib.gunzipSync(gz).readUInt32LE(8) !== M) throw new Error("verification failed");
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, out);
  return { total: N, removed, per: balls.map((b) => b.n), mb: gz.length / 1048576 };
}
