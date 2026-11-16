// THE BOOK THAT CONTAINED THE SEA — one image, drawn entirely in code.
//
// A dark old library at night. On a wooden table lies an open book, its pages
// glowing warm — and out of the book a towering ocean wave is erupting,
// curling over the room, deep indigo water shot through with molten-gold
// light and tiny stars, its crest breaking into spray. A tiny lighthouse
// stands on the other page, its beam cutting through the spray; at the
// table's edge a tiny reader leaps back in shock, chair toppling.
//
// Everything is computed: painterly layers of shaded shapes, a precomputed
// wave distance field, particle splats, glow fields and seeded grain. A
// fixed-seed PRNG drives every placement — no Math.random, no clock — so two
// runs produce byte-identical output.
//
// Pipeline, in order: the wave's Catmull-Rom spine is baked into distance /
// parameter / radius grids; five noise fields and a warm glow field are
// precomputed alongside; every spray droplet, star, mote and fluttering page
// is splatted into an additive buffer by seeded PRNGs; then each output
// pixel shades the room, the book, the wave and the silhouettes from those
// fields at 2x supersampling, and a filmic shoulder plus seeded grain finish
// the frame before the hand-rolled PNG encoder writes it out.
//
// Node 22, standard library only. Writes <outputDir>/entry.png where
// outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output'.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Deterministic PRNG + hashing (never Math.random / Date.now)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash -> [0, 1). Stable across runs and platforms. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth value noise, 1 octave. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in [0, 1]. */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function mixc(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}
function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
function dist2d(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return Math.sqrt(dx * dx + dy * dy);
}
function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}
function sdBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, rot: number): number {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = px - cx;
  const dy = py - cy;
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  const qx = Math.abs(lx) - hx;
  const qy = Math.abs(ly) - hy;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}

// ---------------------------------------------------------------------------
// PNG encoder (truecolor RGB8, per-row best filter, correct CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const row = Buffer.alloc(stride);
  const filt = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    row.set(rgb.subarray(y * stride, (y + 1) * stride));
    let bestType = 0;
    let bestScore = Infinity;
    let bestRow: Buffer | null = null;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0;
        const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
        const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3] : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (row[i] - pred) & 0xff;
        filt[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        bestRow = Buffer.from(filt);
      }
    }
    const off = y * (stride + 1);
    raw[off] = bestType;
    (bestRow as Buffer).copy(raw, off + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor RGB
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Precomputed fields
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;

/** Bilinear sample of a square Float32 grid of size gs, at unit coords. */
function sampleGrid(g: Float32Array, gs: number, x: number, y: number): number {
  const fx = clamp(x, 0, 0.99999) * gs - 0.5;
  const fy = clamp(y, 0, 0.99999) * gs - 0.5;
  const x0 = Math.max(0, Math.floor(fx));
  const y0 = Math.max(0, Math.floor(fy));
  const x1 = Math.min(gs - 1, x0 + 1);
  const y1 = Math.min(gs - 1, y0 + 1);
  const tx = clamp(fx - x0, 0, 1);
  const ty = clamp(fy - y0, 0, 1);
  const a = g[y0 * gs + x0];
  const b = g[y0 * gs + x1];
  const c = g[y1 * gs + x0];
  const d = g[y1 * gs + x1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

// --- Wave spine: rises from the book, leans left, curls over to the right ---
// Control points (x, y, radius) in unit space, y down.
const SPINE_CTRL: [number, number, number][] = [
  [0.515, 0.878, 0.055],
  [0.478, 0.722, 0.108],
  [0.428, 0.566, 0.150],
  [0.412, 0.416, 0.168],
  [0.450, 0.286, 0.150],
  [0.545, 0.196, 0.124],
  [0.672, 0.163, 0.102],
  [0.782, 0.191, 0.080],
  [0.852, 0.263, 0.058],
  [0.862, 0.359, 0.038],
  [0.828, 0.449, 0.018],
];
// Splash blobs where the wave bursts out of the pages (x, y, radius).
const BASE_BLOBS: [number, number, number][] = [
  [0.452, 0.848, 0.020],
  [0.482, 0.836, 0.026],
  [0.540, 0.835, 0.025],
  [0.572, 0.848, 0.019],
  [0.435, 0.866, 0.015],
  [0.588, 0.865, 0.014],
];

interface SpinePt {
  x: number;
  y: number;
  r: number;
  t: number;
}

function buildSpine(): SpinePt[] {
  const pts: SpinePt[] = [];
  const n = SPINE_CTRL.length;
  const per = 26;
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  for (let i = 0; i < n - 1; i++) {
    const p0 = SPINE_CTRL[Math.max(0, i - 1)];
    const p1 = SPINE_CTRL[i];
    const p2 = SPINE_CTRL[i + 1];
    const p3 = SPINE_CTRL[Math.min(n - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      pts.push({
        x: cr(p0[0], p1[0], p2[0], p3[0], t),
        y: cr(p0[1], p1[1], p2[1], p3[1], t),
        r: Math.max(0.012, cr(p0[2], p1[2], p2[2], p3[2], t)),
        t: 0,
      });
    }
  }
  const last = SPINE_CTRL[n - 1];
  pts.push({ x: last[0], y: last[1], r: last[2], t: 0 });
  for (let i = 0; i < pts.length; i++) pts[i].t = i / (pts.length - 1);
  return pts;
}

const WG = 512;
const waveD = new Float32Array(WG * WG);
const waveT = new Float32Array(WG * WG);
const waveR = new Float32Array(WG * WG);
const spine = buildSpine();

function buildWaveGrids(): void {
  for (let gy = 0; gy < WG; gy++) {
    const y = (gy + 0.5) / WG;
    for (let gx = 0; gx < WG; gx++) {
      const x = (gx + 0.5) / WG;
      let best = Infinity;
      let bt = 0;
      let br = 0.05;
      for (let i = 0; i < spine.length; i++) {
        const s = spine[i];
        const d = dist2d(x, y, s.x, s.y) - s.r;
        if (d < best) {
          best = d;
          bt = s.t;
          br = s.r;
        }
      }
      for (let i = 0; i < BASE_BLOBS.length; i++) {
        const b = BASE_BLOBS[i];
        const d = dist2d(x, y, b[0], b[1]) - b[2];
        if (d < best) {
          best = d;
          bt = 0.03;
          br = b[2];
        }
      }
      const idx = gy * WG + gx;
      waveD[idx] = best;
      waveT[idx] = bt;
      waveR[idx] = br;
    }
  }
}

// --- Noise detail grids (1024) ---
const NG = 1024;
const noiseA = new Float32Array(NG * NG); // general fbm, scale 7
const noiseB = new Float32Array(NG * NG); // vertically stretched streaks
const noiseC = new Float32Array(NG * NG); // fine foam grain, scale 30
const noiseD = new Float32Array(NG * NG); // coarse clumps for foam breakup
const noiseE = new Float32Array(NG * NG); // multi-scale fbm for foam breakup

function buildNoiseGrids(): void {
  for (let y = 0; y < NG; y++) {
    const v = (y + 0.5) / NG;
    for (let x = 0; x < NG; x++) {
      const u = (x + 0.5) / NG;
      const idx = y * NG + x;
      noiseA[idx] = fbm(u * 7 + 3.1, v * 7 + 8.7, 3);
      noiseB[idx] = fbm(u * 2.6 + 11.3, v * 15 + 1.9, 3);
      noiseC[idx] = fbm(u * 30 + 5.5, v * 30 + 2.2, 2);
      noiseD[idx] = vnoise(u * 85 + 13.7, v * 85 + 4.3);
      noiseE[idx] = fbm(u * 55 + 7.9, v * 55 + 12.4, 3);
    }
  }
}

// --- Glow field (256, single channel warm light) ---
const GG = 256;
const glowGrid = new Float32Array(GG * GG);

function splatGlow(cx: number, cy: number, radiusPx: number, intensity: number): void {
  const gx = cx * GG;
  const gy = cy * GG;
  const gr = (radiusPx / W) * GG;
  const x0 = Math.max(0, Math.floor(gx - gr));
  const x1 = Math.min(GG - 1, Math.ceil(gx + gr));
  const y0 = Math.max(0, Math.floor(gy - gr));
  const y1 = Math.min(GG - 1, Math.ceil(gy + gr));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = dist2d(x + 0.5, y + 0.5, gx, gy) / gr;
      if (d < 1) glowGrid[y * GG + x] += intensity * Math.exp(-d * d * 3.2);
    }
  }
}

function buildGlow(): void {
  splatGlow(0.5, 0.878, 185, 0.85); // the glowing book
  splatGlow(0.512, 0.85, 100, 0.45); // splash base
  splatGlow(0.665, 0.335, 150, 0.38); // the curl's throat
  splatGlow(0.71, 0.155, 210, 0.68); // gold crest
  splatGlow(0.408, 0.792, 60, 0.8); // lighthouse lamp
}

// --- Additive particle buffer (1024, RGB) ---
const splatBuf = new Float32Array(W * H * 3);

function splat(x: number, y: number, radiusPx: number, col: RGB, intensity: number): void {
  const cx = x * W;
  const cy = y * H;
  const x0 = Math.max(0, Math.floor(cx - radiusPx));
  const x1 = Math.min(W - 1, Math.ceil(cx + radiusPx));
  const y0 = Math.max(0, Math.floor(cy - radiusPx));
  const y1 = Math.min(H - 1, Math.ceil(cy + radiusPx));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const d = dist2d(px + 0.5, py + 0.5, cx, cy) / radiusPx;
      if (d >= 1) continue;
      const f = Math.exp(-d * d * 3.5) * intensity;
      const idx = (py * W + px) * 3;
      splatBuf[idx] += col[0] * f;
      splatBuf[idx + 1] += col[1] * f;
      splatBuf[idx + 2] += col[2] * f;
    }
  }
}

const FOAM_COL: RGB = [1.0, 0.88, 0.62];
const GOLD_COL: RGB = [1.0, 0.62, 0.22];

function buildSplats(): void {
  const rnd = mulberry32(0x5eed1234);
  // Spray bursting off the crest and lip (t in [0.55, 1]).
  for (let i = 0; i < 640; i++) {
    const t = 0.55 + 0.45 * Math.pow(rnd(), 0.8);
    const si = Math.min(spine.length - 1, Math.floor(t * (spine.length - 1)));
    const s = spine[si];
    const sPrev = spine[Math.max(0, si - 2)];
    const sNext = spine[Math.min(spine.length - 1, si + 2)];
    let nx = -(sNext.y - sPrev.y);
    let ny = sNext.x - sPrev.x;
    const nl = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nl;
    ny /= nl;
    // Outward = away from the curl centre.
    if ((s.x - 0.665) * nx + (s.y - 0.335) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = s.r * (0.85 + rnd() * 0.5);
    const scatter = 0.012 + Math.pow(rnd(), 1.6) * 0.10;
    const dirx = nx * 0.75 + 0.35 + (rnd() - 0.5) * 0.7;
    const diry = ny * 0.75 - 0.45 + (rnd() - 0.5) * 0.7;
    const px = s.x + nx * off + dirx * scatter;
    const py = s.y + ny * off + diry * scatter;
    const size = 0.8 + rnd() * rnd() * 3.4;
    splat(px, py, size, FOAM_COL, 0.35 + rnd() * 0.55);
  }
  // Droplet streaks flying off the tip: short chains along the motion.
  for (let i = 0; i < 42; i++) {
    const t = 0.86 + rnd() * 0.14;
    const si = Math.min(spine.length - 1, Math.floor(t * (spine.length - 1)));
    const s = spine[si];
    const bx = s.x + (rnd() - 0.5) * 0.05;
    const by = s.y + (rnd() - 0.5) * 0.05;
    const vx = 0.55 + rnd() * 0.5;
    const vy = 0.35 + rnd() * 0.55;
    for (let k = 0; k < 3; k++) {
      splat(bx + vx * 0.028 * k, by + vy * 0.028 * k, 1.1 + rnd() * 1.6, FOAM_COL, 0.5 - k * 0.13);
    }
  }
  // Splash droplets at the base, leaping off the pages.
  for (let i = 0; i < 170; i++) {
    const ang = Math.PI * (0.08 + rnd() * 0.84); // upward arc
    const rad = 0.03 + Math.pow(rnd(), 1.4) * 0.11;
    const px = 0.512 + Math.cos(ang) * rad * 1.25;
    const py = 0.855 - Math.sin(ang) * rad;
    splat(px, py, 0.8 + rnd() * rnd() * 3.0, FOAM_COL, 0.3 + rnd() * 0.5);
  }
  // Tiny stars inside the wave body.
  let placed = 0;
  let guard = 0;
  while (placed < 130 && guard < 6000) {
    guard++;
    const px = 0.24 + rnd() * 0.66;
    const py = 0.03 + rnd() * 0.80;
    const d = sampleGrid(waveD, WG, px, py);
    if (d > -0.02) continue;
    const warm = rnd();
    const col: RGB = warm < 0.6 ? GOLD_COL : [0.85, 0.92, 1.0];
    splat(px, py, 0.7 + rnd() * 1.3, col, 0.5 + rnd() * 0.8);
    placed++;
  }
  // Dust motes drifting in the lighthouse beam.
  const lampX = 0.408;
  const lampY = 0.792;
  const bdx = -0.885;
  const bdy = -0.465;
  for (let i = 0; i < 90; i++) {
    const along = 0.04 + rnd() * 0.55;
    const perp = (rnd() - 0.5) * (0.012 + along * 0.16);
    const px = lampX + bdx * along - bdy * perp;
    const py = lampY + bdy * along + bdx * perp;
    splat(px, py, 0.7 + rnd() * 1.1, [1.0, 0.8, 0.5], 0.10 + rnd() * 0.22);
  }
  // Ambient motes in the book's glow.
  for (let i = 0; i < 110; i++) {
    const px = 0.28 + rnd() * 0.44;
    const py = 0.45 + rnd() * 0.42;
    splat(px, py, 0.6 + rnd() * 1.0, [1.0, 0.75, 0.42], 0.05 + rnd() * 0.13);
  }
  // Big soft foreground droplets — spray flying at the viewer, kept near
  // the crest and the frame's lower corners so they read as near-camera
  // water, not smudges on the room.
  for (let i = 0; i < 14; i++) {
    let px: number;
    let py: number;
    if (i < 8) {
      px = 0.55 + rnd() * 0.43;
      py = 0.04 + rnd() * 0.46;
    } else {
      px = rnd() < 0.5 ? rnd() * 0.20 : 0.80 + rnd() * 0.20;
      py = 0.62 + rnd() * 0.34;
    }
    splat(px, py, 13 + rnd() * 30, [0.75, 0.85, 1.0], 0.04 + rnd() * 0.07);
    splat(px - 0.006, py - 0.008, 4 + rnd() * 6, [1.0, 0.95, 0.85], 0.08 + rnd() * 0.10);
  }
}

// --- Bookshelf layout (seeded) ---
interface BookDef {
  x0: number;
  x1: number;
  h: number;
  lean: number;
  col: RGB;
  band: boolean;
}
interface ShelfRow {
  top: number;
  boardY: number;
  books: BookDef[];
}
const SHELF_PALETTE: RGB[] = [
  [0.30, 0.15, 0.11],
  [0.36, 0.21, 0.12],
  [0.15, 0.24, 0.20],
  [0.32, 0.25, 0.13],
  [0.20, 0.15, 0.26],
  [0.38, 0.24, 0.15],
  [0.13, 0.20, 0.26],
  [0.28, 0.13, 0.15],
  [0.24, 0.28, 0.14],
  [0.34, 0.28, 0.20],
];
const shelfRows: ShelfRow[] = [];

function buildShelves(): void {
  const rnd = mulberry32(0xb00c5);
  for (let side = 0; side < 2; side++) {
    const ux0 = side === 0 ? 0.014 : 0.800;
    const ux1 = side === 0 ? 0.200 : 0.986;
    for (let r = 0; r < 5; r++) {
      const top = 0.048 + r * 0.163;
      const boardY = top + 0.148;
      const books: BookDef[] = [];
      let x = ux0 + 0.006 + rnd() * 0.006;
      while (x < ux1 - 0.02) {
        if (rnd() < 0.10) {
          x += 0.012 + rnd() * 0.02; // a gap on the shelf
          continue;
        }
        const w = 0.015 + rnd() * 0.019;
        const h = 0.088 + rnd() * 0.048;
        const lean = rnd() < 0.14 ? (rnd() - 0.5) * 0.035 : 0;
        const col = SHELF_PALETTE[Math.floor(rnd() * SHELF_PALETTE.length)];
        books.push({ x0: x, x1: Math.min(x + w, ux1 - 0.004), h, lean, col, band: rnd() < 0.45 });
        x += w + 0.0016;
      }
      shelfRows.push({ top, boardY, books });
    }
  }
}

// --- Fluttering loose pages caught in the spray ---
interface PageDef {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  rot: number;
  bright: number;
}
const flutterPages: PageDef[] = [];

function buildPages(): void {
  const rnd = mulberry32(0xf17e5);
  for (let i = 0; i < 9; i++) {
    const w = 0.030 + rnd() * 0.028;
    flutterPages.push({
      cx: 0.56 + rnd() * 0.36,
      cy: 0.30 + rnd() * 0.36,
      hx: w / 2,
      hy: (w * 0.72) / 2,
      rot: rnd() * Math.PI * 2,
      bright: 0.7 + rnd() * 0.5,
    });
  }
  for (let i = 0; i < 2; i++) {
    const w = 0.034 + rnd() * 0.02;
    flutterPages.push({
      cx: 0.30 + rnd() * 0.13,
      cy: 0.55 + rnd() * 0.15,
      hx: w / 2,
      hy: (w * 0.72) / 2,
      rot: rnd() * Math.PI * 2,
      bright: 0.65 + rnd() * 0.4,
    });
  }
}

// ---------------------------------------------------------------------------
// Scene shapes (unit space, y down)
// ---------------------------------------------------------------------------

/** Point in quad via two triangles; returns [u, v] or null. u: gutter->outer. */
function quadUV(
  x: number, y: number,
  gT: [number, number], oT: [number, number], oB: [number, number], gB: [number, number],
): [number, number] | null {
  const tri = (
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  ): [number, number, number] | null => {
    const v0x = bx - ax;
    const v0y = by - ay;
    const v1x = cx - ax;
    const v1y = cy - ay;
    const v2x = x - ax;
    const v2y = y - ay;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-9) return null;
    const u = (v2x * v1y - v1x * v2y) / den;
    const v = (v0x * v2y - v2x * v0y) / den;
    if (u < -0.001 || v < -0.001 || u + v > 1.001) return null;
    return [u, v, 1 - u - v];
  };
  // Triangle gutterTop - outerTop - gutterBottom: uv (0,0),(1,0),(0,1).
  // tri() returns [weight of b, weight of c, weight of a].
  let b = tri(gT[0], gT[1], oT[0], oT[1], gB[0], gB[1]);
  if (b) return [b[0], b[1]];
  // Triangle outerTop - outerBottom - gutterBottom: uv (1,0),(1,1),(0,1).
  b = tri(oT[0], oT[1], oB[0], oB[1], gB[0], gB[1]);
  if (b) return [b[2] + b[0], b[0] + b[1]];
  return null;
}

/** The tiny lighthouse on the left page: SDF (negative inside). */
function lighthouseD(x: number, y: number): number {
  let d = sdCapsule(x, y, 0.408, 0.866, 0.408, 0.806, 0.0135);
  d = Math.min(d, dist2d(x, y, 0.408, 0.864) - 0.019); // base flare
  d = Math.min(d, sdBox(x, y, 0.408, 0.801, 0.0155, 0.005, 0)); // gallery
  d = Math.min(d, sdBox(x, y, 0.408, 0.790, 0.0088, 0.0078, 0)); // lamp room
  // Roof: small triangle approximated by a clipped disc.
  const roof = Math.max(dist2d(x, y, 0.408, 0.786) - 0.0105, y - 0.7845);
  d = Math.min(d, roof);
  return d;
}

/** The startled reader, leaping back: SDF built from capsules, local frame
 *  rotated about the feet so the whole body tips away from the book. */
function readerD(x: number, y: number): number {
  const fx = 0.762;
  const fy = 0.912;
  const rot = -0.42; // tip back, away from the wave (wave is to the left)
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = x - fx;
  const dy = y - fy;
  const lx = c * dx - s * dy;
  const ly = s * dx + c * dy;
  const px = lx;
  const py = ly;
  let d = sdCapsule(px, py, 0, -0.004, 0.004, -0.054, 0.0115); // torso
  d = Math.min(d, dist2d(px, py, 0.009, -0.068) - 0.0105); // head
  d = Math.min(d, sdCapsule(px, py, 0.002, -0.049, -0.017, -0.059, 0.0046)); // front arm up
  d = Math.min(d, sdCapsule(px, py, -0.017, -0.059, -0.021, -0.077, 0.0042));
  d = Math.min(d, sdCapsule(px, py, 0.004, -0.050, 0.017, -0.057, 0.0046)); // back arm flung
  d = Math.min(d, sdCapsule(px, py, 0.017, -0.057, 0.027, -0.071, 0.0042));
  d = Math.min(d, sdCapsule(px, py, 0.001, -0.006, 0.016, -0.025, 0.0052)); // trailing leg
  d = Math.min(d, sdCapsule(px, py, 0.016, -0.025, 0.031, -0.009, 0.0046));
  d = Math.min(d, sdCapsule(px, py, 0.0, -0.006, -0.011, -0.028, 0.0052)); // planted leg
  d = Math.min(d, sdCapsule(px, py, -0.011, -0.028, -0.015, -0.002, 0.0046));
  return d;
}

/** The toppling chair: SDF from rotated boxes. */
function chairD(x: number, y: number): number {
  const cx = 0.852;
  const cy = 0.918;
  const rot = 0.95; // falling away to the right
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = x - cx;
  const dy = y - cy;
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  let d = sdBox(lx, ly, 0, -0.030, 0.0042, 0.030, 0); // back upright
  d = Math.min(d, sdBox(lx, ly, 0.001, -0.058, 0.017, 0.0038, 0)); // back top rail
  d = Math.min(d, sdBox(lx, ly, 0.002, 0.0, 0.019, 0.0042, 0)); // seat
  d = Math.min(d, sdBox(lx, ly, -0.015, 0.016, 0.0036, 0.017, 0)); // front leg
  d = Math.min(d, sdBox(lx, ly, 0.017, 0.016, 0.0036, 0.017, 0)); // back leg
  return d;
}

/** Rim light factor for a silhouette SDF: edge band facing the book's glow. */
function rimLight(dFn: (x: number, y: number) => number, x: number, y: number, d: number): number {
  if (d > 0.001 || d < -0.009) return 0;
  const e = 0.0028;
  const gx = (dFn(x + e, y) - dFn(x - e, y)) / (2 * e);
  const gy = (dFn(x, y + e) - dFn(x, y - e)) / (2 * e);
  const gl = Math.sqrt(gx * gx + gy * gy) || 1;
  const nx = gx / gl;
  const ny = gy / gl;
  // Direction toward the book's glow at (0.5, 0.88).
  let lx = 0.5 - x;
  let ly = 0.88 - y;
  const ll = Math.sqrt(lx * lx + ly * ly) || 1;
  lx /= ll;
  ly /= ll;
  const facing = clamp01(nx * lx + ny * ly);
  const band = smoothstep(-0.009, -0.0008, d);
  return Math.pow(facing, 1.6) * band;
}

// ---------------------------------------------------------------------------
// Per-pixel shading (unit coords, returns linear HDR colour)
// ---------------------------------------------------------------------------

const GOLD: RGB = [1.0, 0.62, 0.24];
const GLOW_TINT: RGB = [1.0, 0.66, 0.32];

function shelfShade(x: number, y: number, glow: number): RGB | null {
  const left = x < 0.5;
  const ux0 = left ? 0.008 : 0.794;
  const ux1 = left ? 0.206 : 0.992;
  if (x < ux0 || x > ux1) return null;
  // Unit frame.
  const frame: RGB = [0.045, 0.032, 0.022];
  if (x < ux0 + 0.008 || x > ux1 - 0.008) return frame;
  const rowIdx = Math.floor((y - 0.048) / 0.163);
  if (rowIdx < 0 || rowIdx > 4) return frame;
  const row = shelfRows[(left ? 0 : 1) * 5 + rowIdx];
  // Backing panel.
  let col: RGB = [0.020, 0.016, 0.013];
  // Shelf board.
  if (y > row.boardY - 0.011) {
    const t = (y - (row.boardY - 0.011)) / 0.011;
    col = [0.075 * (1 - t * 0.5), 0.052 * (1 - t * 0.5), 0.032 * (1 - t * 0.5)];
    if (y < row.boardY - 0.0085) col = [0.11, 0.078, 0.046]; // lit top edge of board
    return col;
  }
  // Books.
  for (let i = 0; i < row.books.length; i++) {
    const b = row.books[i];
    const f = clamp((row.boardY - y) / b.h, 0, 1); // 0 at board, 1 at top
    if (f > 1) continue;
    const shift = b.lean * f;
    if (x < b.x0 + shift || x > b.x1 + shift) continue;
    if (y < row.boardY - b.h) continue;
    const u = (x - shift - b.x0) / (b.x1 - b.x0);
    const edge = Math.min(u, 1 - u);
    let shade = 0.55 + 0.45 * smoothstep(0, 0.30, edge); // rounded spine
    shade *= 0.82 + 0.30 * f; // darker toward the board
    shade *= 0.8 + 0.35 * hash2(i * 7 + rowIdx * 31, left ? 3 : 9);
    col = [b.col[0] * shade, b.col[1] * shade, b.col[2] * shade];
    if (b.band && Math.abs(f - 0.78) < 0.035) {
      col = [col[0] + 0.10, col[1] + 0.075, col[2] + 0.03]; // gilt band
    }
    // Warm rim on the side facing the room's light.
    const inner = left ? smoothstep(0.55, 1.0, u) : smoothstep(0.45, 0.0, u);
    const rim = inner * (0.25 + glow * 1.1) * 0.5;
    col = [col[0] + GOLD[0] * rim * 0.35, col[1] + GOLD[1] * rim * 0.35, col[2] + GOLD[2] * rim * 0.35];
    return col;
  }
  return col;
}

function shade(x: number, y: number): RGB {
  // Wave field first (drives shadow + halo on the room behind it).
  const d0 = sampleGrid(waveD, WG, x, y);
  const wt = sampleGrid(waveT, WG, x, y);
  const wr = sampleGrid(waveR, WG, x, y);
  const nA = sampleGrid(noiseA, NG, x, y);
  const nB = sampleGrid(noiseB, NG, x, y);
  const nC = sampleGrid(noiseC, NG, x, y);
  const nD = sampleGrid(noiseD, NG, x, y);
  const nE = sampleGrid(noiseE, NG, x, y);
  const glow = sampleGrid(glowGrid, GG, x, y);
  const disp = (nA - 0.5) * (0.010 + 0.030 * smoothstep(0.45, 1.0, wt)) + (nC - 0.5) * 0.004;
  const d = d0 + disp;
  const ao = d > 0 ? 1 - 0.38 * smoothstep(0.10, 0.004, d) : 1;

  // --- Wall ---
  let col: RGB = [
    mix(0.030, 0.012, y) + 0.012 * nA,
    mix(0.028, 0.011, y) + 0.008 * nA,
    mix(0.048, 0.022, y) + 0.010 * nA,
  ];
  col = [
    col[0] + GLOW_TINT[0] * glow * 0.16,
    col[1] + GLOW_TINT[1] * glow * 0.16,
    col[2] + GLOW_TINT[2] * glow * 0.16,
  ];

  // --- Shelves ---
  if ((x < 0.21 || x > 0.79) && y < 0.85) {
    const s = shelfShade(x, y, glow);
    if (s) col = s;
  }
  col = [col[0] * ao, col[1] * ao, col[2] * ao];

  // --- Table ---
  if (y > 0.836) {
    const streak = 0.88 + 0.24 * nA;
    let tcol: RGB;
    if (y < 0.972) {
      // Surface: warm pool of light around the book.
      const pool = Math.exp(-(Math.pow((x - 0.5) / 0.30, 2) + Math.pow((y - 0.905) / 0.09, 2)));
      const base: RGB = [0.115, 0.070, 0.040];
      tcol = [
        base[0] * streak + GOLD[0] * pool * 0.26,
        base[1] * streak + GOLD[1] * pool * 0.26,
        base[2] * streak + GOLD[2] * pool * 0.26,
      ];
      // Soft shadow the wave throws on the table behind the book.
      const sh = Math.exp(-(Math.pow((x - 0.52) / 0.21, 2) + Math.pow((y - 0.862) / 0.045, 2)));
      tcol = [tcol[0] * (1 - 0.4 * sh), tcol[1] * (1 - 0.4 * sh), tcol[2] * (1 - 0.4 * sh)];
    } else {
      const g = 1 - (y - 0.972) / 0.028;
      tcol = [0.055 * g * streak + 0.012, 0.034 * g * streak + 0.008, 0.020 * g * streak + 0.005];
    }
    col = [tcol[0] * ao, tcol[1] * ao, tcol[2] * ao];
  }

  // --- A stack of closed books on the left of the table ---
  if (x > 0.17 && x < 0.335 && y > 0.845 && y < 0.925) {
    const stack: [number, number, number, number, number, RGB][] = [
      [0.252, 0.903, 0.052, 0.011, 0.03, [0.30, 0.15, 0.11]],
      [0.250, 0.882, 0.046, 0.010, -0.05, [0.15, 0.24, 0.20]],
      [0.253, 0.862, 0.040, 0.009, 0.09, [0.36, 0.21, 0.12]],
    ];
    for (let i = 0; i < stack.length; i++) {
      const [bcx, bcy, bhx, bhy, brot, bcol] = stack[i];
      const bd = sdBox(x, y, bcx, bcy, bhx, bhy, brot);
      if (bd < 0.0012) {
        const lit = 0.55 + 0.5 * glow + 0.25 * nA;
        col = mixc(col, [bcol[0] * lit, bcol[1] * lit, bcol[2] * lit], smoothstep(0.0012, -0.0012, bd));
      }
    }
  }

  // --- The open book ---
  if (x > 0.29 && x < 0.73 && y > 0.82 && y < 0.945) {
    // Cover (slightly larger, dark red-brown).
    const cov = quadUV(x, y, [0.5, 0.843], [0.313, 0.866], [0.320, 0.930], [0.5, 0.920]);
    const covR = quadUV(x, y, [0.5, 0.843], [0.687, 0.866], [0.680, 0.930], [0.5, 0.920]);
    if (cov || covR) col = [0.115, 0.048, 0.034];
    // Pages.
    const pl = quadUV(x, y, [0.5, 0.851], [0.327, 0.871], [0.333, 0.921], [0.5, 0.911]);
    const pr = quadUV(x, y, [0.5, 0.851], [0.673, 0.871], [0.667, 0.921], [0.5, 0.911]);
    const pg = pl || pr;
    if (pg) {
      const u = pg[0];
      const v = pg[1];
      const glowSrc = Math.exp(-(Math.pow(x - 0.5, 2) / 0.012 + Math.pow(y - 0.878, 2) / 0.0035));
      let bright = 0.34 + 1.05 * glowSrc;
      bright *= 1 - 0.30 * u * u; // page curls down toward the outer edge
      bright *= 0.92 + 0.14 * Math.sin(v * Math.PI); // soft top-bottom falloff
      bright *= 0.96 + 0.08 * nA;
      const edge = Math.min(u, 1 - u, v * 1.6, (1 - v) * 1.6);
      bright *= 0.82 + 0.18 * smoothstep(0, 0.10, edge);
      col = [1.02 * bright, 0.80 * bright, 0.50 * bright];
    }
  }

  // --- Lighthouse on the left page ---
  if (x > 0.375 && x < 0.445 && y > 0.76 && y < 0.885) {
    const ld = lighthouseD(x, y);
    if (ld < 0.0012) {
      const rim = rimLight(lighthouseD, x, y, ld);
      const a = smoothstep(0.0012, -0.0012, ld);
      const lc: RGB = [
        0.016 + GOLD[0] * rim * 0.9,
        0.022 + GOLD[1] * rim * 0.9,
        0.038 + GOLD[2] * rim * 0.9,
      ];
      col = mixc(col, lc, a);
      // The lamp itself.
      const lampD = dist2d(x, y, 0.408, 0.7905);
      if (lampD < 0.0048) {
        const li = smoothstep(0.0048, 0.0012, lampD);
        col = mixc(col, [2.3, 1.85, 1.05], li);
      }
    }
  }

  // --- The wave ---
  if (d < 0.004) {
    const depth = clamp(-d / Math.max(wr * 0.95, 0.05), 0, 1);
    const shell = 1 - depth;
    // Deep indigo body; teal light lives only in a thinner outer shell.
    let wcol = mixc([0.075, 0.295, 0.355], [0.008, 0.038, 0.105], smoothstep(0.0, 0.55, Math.pow(depth, 0.8)));
    const shadeVar = 0.76 + 0.52 * nA;
    wcol = [wcol[0] * shadeVar, wcol[1] * shadeVar, wcol[2] * shadeVar];
    // Flow streaks running along the tube (parameterised by spine t).
    const flow = vnoise(wt * 30 + nA * 2.0, depth * 3.0 + wt * 4.0);
    const flowI = Math.pow(flow, 2.0) * (0.35 + 0.65 * shell) * 0.20;
    wcol = [wcol[0] + 0.05 * flowI * 3, wcol[1] + 0.11 * flowI * 3, wcol[2] + 0.12 * flowI * 3];
    // Fine ripple texture on the lit shell.
    const rip = ((nC - 0.5) * 0.07 + (nD - 0.5) * 0.03) * shell;
    wcol = [wcol[0] + rip, wcol[1] + rip, wcol[2] + rip];
    // Molten-gold filaments threading the water (ridged streak noise).
    const crestF = smoothstep(0.66, 0.98, wt);
    const fil = Math.pow(1 - Math.abs(2 * nB - 1), 6);
    const filI = fil * (0.10 + 0.34 * crestF + 0.30 * glow) * (0.30 + 0.70 * shell);
    wcol = [wcol[0] + GOLD[0] * filI, wcol[1] + GOLD[1] * filI, wcol[2] + GOLD[2] * filI];
    // Gold light raking the crest.
    const goldI = crestF * (0.25 + 0.75 * shell) * 1.0;
    wcol = [wcol[0] + GOLD[0] * goldI, wcol[1] + GOLD[1] * goldI, wcol[2] + GOLD[2] * goldI];
    // Warm light from the book and throat glow.
    const glowI = glow * 0.32 * (1 - depth * 0.5);
    wcol = [wcol[0] + GOLD[0] * glowI, wcol[1] + GOLD[1] * glowI, wcol[2] + GOLD[2] * glowI];
    // Specular glints near the crest surface.
    const spec = smoothstep(0.63, 0.95, nC) * crestF * shell;
    wcol = [wcol[0] + spec * 0.42, wcol[1] + spec * 0.34, wcol[2] + spec * 0.21];
    // Foam — intensity modulated by soft multi-scale noise so it breaks
    // into ragged clumps, never a clean outline or mosaic: a noisy band at
    // the surface, a ragged cap at the tip, lining in the throat of the
    // curl, and churn where the wave leaves the pages.
    const patchSoft = smoothstep(0.14, 0.84, nE * 0.7 + nC * 0.3);
    const foamI = 0.30 + 0.70 * patchSoft;
    const band = 0.008 + 0.034 * nC * (0.4 + 0.8 * crestF);
    let foamM = smoothstep(-band, -band * 0.15, d) * foamI * (0.55 + 0.45 * crestF);
    foamM = Math.max(foamM, smoothstep(0.78, 0.96, wt) * smoothstep(0.85, 0.30, depth) * (0.40 + 0.60 * patchSoft));
    const distC = dist2d(x, y, 0.665, 0.335);
    foamM = Math.max(foamM, smoothstep(0.165, 0.125, distC) * smoothstep(-0.002, -0.030, d) * foamI);
    const distBase = dist2d(x, y, 0.512, 0.856);
    foamM = Math.max(foamM, smoothstep(0.074, 0.040, distBase) * smoothstep(-0.001, -0.014, d) * foamI);
    foamM = clamp01(foamM);
    if (foamM > 0.003) {
      const foamCol = mixc([1.0, 0.78, 0.46], [1.05, 0.97, 0.87], nC);
      const fb = (0.80 + 0.24 * nE) * (0.9 + 0.35 * crestF);
      wcol = mixc(wcol, [foamCol[0] * fb, foamCol[1] * fb, foamCol[2] * fb], foamM);
    }
    const a = smoothstep(0.0028, -0.0028, d);
    col = mixc(col, wcol, a);
  }

  // --- Fluttering pages in the spray ---
  for (let i = 0; i < flutterPages.length; i++) {
    const p = flutterPages[i];
    if (Math.abs(x - p.cx) > p.hx + 0.02 || Math.abs(y - p.cy) > p.hx + 0.02) continue;
    const pd = sdBox(x, y, p.cx, p.cy, p.hx, p.hy, p.rot);
    if (pd < 0.0012) {
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      const lu = (c * (x - p.cx) + s * (y - p.cy)) / p.hx; // -1..1 across
      const fold = 1 - 0.28 * Math.abs(lu); // crease shading
      const pb = p.bright * fold * (0.92 + 0.16 * nA);
      const pc: RGB = [1.0 * pb, 0.79 * pb, 0.50 * pb];
      col = mixc(col, pc, smoothstep(0.0012, -0.0012, pd));
    }
  }

  // --- Reader + chair silhouettes ---
  if (x > 0.70 && x < 0.85 && y > 0.78 && y < 0.935) {
    const rd = readerD(x, y);
    if (rd < 0.0012) {
      const rim = rimLight(readerD, x, y, rd);
      const rc: RGB = [
        0.010 + GOLD[0] * rim * 1.15,
        0.014 + GOLD[1] * rim * 1.15,
        0.026 + GOLD[2] * rim * 1.15,
      ];
      col = mixc(col, rc, smoothstep(0.0012, -0.0012, rd));
    }
  }
  if (x > 0.79 && x < 0.94 && y > 0.82 && y < 0.97) {
    const cd = chairD(x, y);
    if (cd < 0.0012) {
      const rim = rimLight(chairD, x, y, cd);
      const cc: RGB = [
        0.030 + GOLD[0] * rim * 0.7,
        0.020 + GOLD[1] * rim * 0.7,
        0.012 + GOLD[2] * rim * 0.7,
      ];
      col = mixc(col, cc, smoothstep(0.0012, -0.0012, cd));
    }
  }

  // --- Lighthouse beam, cutting through the spray ---
  {
    const lx = 0.408;
    const ly = 0.7905;
    const bdx = -0.885;
    const bdy = -0.465;
    const px = x - lx;
    const py = y - ly;
    const along = px * bdx + py * bdy;
    if (along > 0 && along < 0.66) {
      const perp = Math.abs(px * -bdy + py * bdx);
      const width = 0.006 + along * 0.085;
      const beam = Math.exp(-Math.pow(perp / width, 2)) * (1 - along / 0.66) * 0.34;
      col = [col[0] + beam * 1.0, col[1] + beam * 0.82, col[2] + beam * 0.52];
    }
  }

  // --- Particles + glow (additive) ---
  const si = (Math.min(H - 1, Math.floor(y * H)) * W + Math.min(W - 1, Math.floor(x * W))) * 3;
  col = [
    col[0] + splatBuf[si] + GLOW_TINT[0] * glow * 0.34,
    col[1] + splatBuf[si + 1] + GLOW_TINT[1] * glow * 0.34,
    col[2] + splatBuf[si + 2] + GLOW_TINT[2] * glow * 0.34,
  ];

  // --- Vignette ---
  const vd = dist2d(x, y, 0.5, 0.46);
  const vig = 1 - 0.46 * smoothstep(0.52, 1.02, vd);
  col = [col[0] * vig, col[1] * vig, col[2] * vig];
  return col;
}

// ---------------------------------------------------------------------------
// Render: 2x supersampling, filmic shoulder, seeded grain
// ---------------------------------------------------------------------------

function render(): Uint8Array {
  buildWaveGrids();
  buildNoiseGrids();
  buildGlow();
  buildShelves();
  buildPages();
  buildSplats();

  const acc = new Float32Array(W * H * 3);
  const SS = 2;
  const offs = [0.25, 0.75];
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + offs[sx]) / W, (py + offs[sy]) / H);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const idx = (py * W + px) * 3;
      acc[idx] = r / 4;
      acc[idx + 1] = g / 4;
      acc[idx + 2] = b / 4;
    }
  }

  const out = new Uint8Array(W * H * 3);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const idx = (py * W + px) * 3;
      const grain = (hash2(px * 3 + 17, py * 3 + 91) - 0.5) * 0.013;
      for (let ch = 0; ch < 3; ch++) {
        let v = acc[idx + ch];
        v = 1 - Math.exp(-v * 1.5); // filmic shoulder
        v = Math.pow(Math.max(v, 0), 0.92);
        const luma = 0.35 + 0.65 * (1 - v);
        v += grain * luma * (ch === 2 ? 0.8 : 1);
        out[idx + ch] = Math.round(clamp01(v) * 255);
      }
    }
  }
  return out;
}

function main(): void {
  const t0 = performance.now();
  const rgb = render();
  const png = encodePNG(W, H, rgb);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  const ms = Math.round(performance.now() - t0);
  console.log(`entry.png: ${W}x${H}, ${png.length} bytes, rendered in ${ms} ms`);
}

main();
