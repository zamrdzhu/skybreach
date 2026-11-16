// SKYBREACH — one image, drawn entirely in code.
//
// A colossal whale breaches out of a sea of clouds, leaping through an enormous
// ring of molten light; a tiny human tumbles beside it, holding a small lantern,
// for scale. Everything is computed per-pixel from signed-distance fields with a
// fixed-seed PRNG: no assets, no randomness at run time, byte-identical output.
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

/** Two-three octave fractal noise in [0, 1]. */
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
/** Polynomial smooth-min for blending SDF primitives. */
function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    cur.set(rgb.subarray(y * stride, (y + 1) * stride));
    // Try every filter, keep the one with the smallest sum of |signed bytes|.
    let bestType = 0;
    let bestScore = Infinity;
    let bestRow: Buffer | null = null;
    for (let f = 0; f <= 4; f++) {
      const row = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? cur[i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) pred = paeth(a, b, c);
        const v = (cur[i] - pred) & 0xff;
        row[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = f;
        bestRow = row;
      }
    }
    const off = y * (stride + 1);
    raw[off] = bestType;
    bestRow!.copy(raw, off + 1);
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
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
// Scene definition (all coordinates in final-image pixels, 1024 x 1024)
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;
const SS = 2; // supersampling factor
const RW = W * SS;
const RH = H * SS;

// The ring of light.
const RING_X = 578;
const RING_Y = 348;
const RING_R = 252;

// Where the whale bursts out of the cloud sea.
const BREACH_X = 330;
const BREACH_Y = 682;

// Palette.
const SKY_TOP: RGB = [0.012, 0.02, 0.07];
const SKY_MID: RGB = [0.028, 0.095, 0.185];
const SKY_DEEP: RGB = [0.006, 0.01, 0.028];
const TEAL_GLOW: RGB = [0.05, 0.24, 0.31];
const GOLD_CORE: RGB = [1.0, 0.93, 0.78];
const GOLD_MID: RGB = [1.0, 0.7, 0.31];
const GOLD_DEEP: RGB = [0.97, 0.5, 0.15];
const WHALE_BASE: RGB = [0.02, 0.032, 0.082];
const WHALE_BELLY: RGB = [0.045, 0.09, 0.16];
const RIM_GOLD: RGB = [1.0, 0.75, 0.4];
const CLOUD_SHADOW: RGB = [0.04, 0.082, 0.165];
const CLOUD_DEEP: RGB = [0.016, 0.04, 0.088];
const CLOUD_MID: RGB = [0.07, 0.215, 0.295];
const CLOUD_LIT: RGB = [0.95, 0.6, 0.29];
const CLOUD_HI: RGB = [1.0, 0.84, 0.58];
const HUMAN_BASE: RGB = [0.01, 0.014, 0.036];

// --- Whale body: a chain of circles along a Catmull-Rom spine ---------------
// Control points: [x, y, radius] from tail stock to snout. The back (upper side)
// stays comparatively flat while the belly (lower side) carries the curve, and
// the head is blunt: a melon and jaw in front of the widest point.
const SPINE_CTRL: Array<[number, number, number]> = [
  [268, 678, 16],
  [340, 612, 28],
  [426, 536, 55],
  [512, 446, 82],
  [602, 364, 90],
  [690, 292, 78],
  [758, 242, 52],
  [798, 214, 34],
  [816, 202, 23],
];

interface SpineSample {
  x: number;
  y: number;
  r: number;
}
const SPINE: SpineSample[] = (() => {
  const pts = SPINE_CTRL;
  const out: SpineSample[] = [];
  const ext = [pts[0], ...pts, pts[pts.length - 1]];
  for (let s = 0; s < ext.length - 3; s++) {
    const p0 = ext[s];
    const p1 = ext[s + 1];
    const p2 = ext[s + 2];
    const p3 = ext[s + 3];
    const steps = 7;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), y: cr(p0[1], p1[1], p2[1], p3[1]), r: cr(p0[2], p1[2], p2[2], p3[2]) });
    }
  }
  const last = pts[pts.length - 1];
  out.push({ x: last[0], y: last[1], r: last[2] });
  // Shift every sample toward the belly side: the back line pulls in and
  // flattens while the belly rounds out, which is what makes the tube read
  // as a whale rather than a teardrop.
  for (let i = 0; i < out.length; i++) {
    const prev = out[Math.max(0, i - 1)];
    const next = out[Math.min(out.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tl = Math.sqrt(tx * tx + ty * ty) || 1;
    tx /= tl;
    ty /= tl;
    // The two normals; the belly one has the larger downward component.
    let nx = ty;
    let ny = -tx;
    if (ny < 0 || (ny === 0 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    out[i].x += nx * out[i].r * 0.13;
    out[i].y += ny * out[i].r * 0.13;
  }
  return out;
})();

/** Signed distance to the whale (body + flukes + pectoral fin). */
function whaleD(x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < SPINE.length; i++) {
    const s = SPINE[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) - s.r;
    if (dist < d) d = dist;
  }
  // Tail flukes: two broad blades spread near-horizontally from the stock,
  // each a thick capsule tipped with a smaller circle.
  d = smin(d, sdCapsule(x, y, 268, 678, 176, 642, 13), 10);
  d = smin(d, sdCapsule(x, y, 268, 678, 324, 728, 12), 10);
  const tipL = Math.sqrt((x - 160) ** 2 + (y - 636) ** 2) - 7;
  const tipR = Math.sqrt((x - 342) ** 2 + (y - 738) ** 2) - 6;
  d = smin(d, Math.min(tipL, tipR), 8);
  // Pectoral fin: a slim blade swept back along the body (down-left, toward
  // the tail) instead of stabbing straight down.
  d = smin(d, sdCapsule(x, y, 558, 494, 478, 578, 9), 12);
  d = smin(d, sdCapsule(x, y, 478, 578, 440, 610, 4.5), 8);
  return d;
}

// --- Tiny human, tumbling, lantern in the raised hand ------------------------
const HUMAN_SEGMENTS: Array<[number, number, number, number, number]> = [
  // torso: pelvis -> chest
  [712, 566, 706, 542, 5],
  // arm 1: shoulder -> elbow -> hand
  [706, 544, 688, 530, 4],
  [688, 530, 676, 542, 3.5],
  // arm 2 (raised, holds the lantern): shoulder -> elbow -> hand
  [706, 544, 726, 532, 4],
  [726, 532, 739, 519, 3.5],
  // leg 1: pelvis -> knee -> foot
  [712, 566, 725, 584, 4.5],
  [725, 584, 719, 604, 3.5],
  // leg 2: pelvis -> knee -> foot
  [712, 566, 696, 582, 4.5],
  [696, 582, 701, 602, 3.5],
];
const HUMAN_HEAD: [number, number, number] = [700, 524, 7.5];
const LANTERN_X = 743;
const LANTERN_Y = 514;

function humanD(x: number, y: number): number {
  let d = Math.sqrt((x - HUMAN_HEAD[0]) ** 2 + (y - HUMAN_HEAD[1]) ** 2) - HUMAN_HEAD[2];
  for (const s of HUMAN_SEGMENTS) {
    const dd = sdCapsule(x, y, s[0], s[1], s[2], s[3], s[4]);
    if (dd < d) d = dd;
  }
  return d;
}

// --- Cloud sea: SDF precomputed on a coarse grid, bilinearly sampled --------
const CLOUD_GRID = 512;
const cloudGrid = new Float32Array(CLOUD_GRID * CLOUD_GRID);

interface CloudCircle {
  x: number;
  y: number;
  r: number;
}
/** The cloud deck's surface height at column x: rolling swells plus a mound
 *  raised where the whale bursts through. Shading keys off this, not off the
 *  SDF, so the depths fall away like fog instead of stacking into strata. */
function cloudSurf(x: number): number {
  let y = 706 + 34 * Math.sin(x * 0.0038 + 1.3) + 22 * Math.sin(x * 0.011 + 4.0);
  y -= 52 * Math.exp(-(((x - BREACH_X) / 135) ** 2)); // mound at the breach
  return y;
}

const CLOUD_CIRCLES: CloudCircle[] = (() => {
  const rng = mulberry32(0xc10d5);
  const circles: CloudCircle[] = [];
  // One row of broad billows along the surface; the smooth-min union in the
  // grid build melts them into a single rolling deck with no creases. Far
  // below the surface the renderer treats the deck as solid regardless.
  for (let x = -140; x < W + 140; x += 58) {
    const r1 = 62 + rng() * 62;
    circles.push({ x: x + (rng() - 0.5) * 24, y: cloudSurf(x) + r1 * 0.4, r: r1 });
  }
  return circles;
})();

function buildCloudGrid(): void {
  const step = W / CLOUD_GRID;
  for (let gy = 0; gy < CLOUD_GRID; gy++) {
    const y = (gy + 0.5) * step;
    for (let gx = 0; gx < CLOUD_GRID; gx++) {
      const x = (gx + 0.5) * step;
      let d = Infinity;
      for (const c of CLOUD_CIRCLES) {
        const dx = x - c.x;
        if (dx > c.r + 60 || dx < -c.r - 60) continue;
        const dy = y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy) - c.r;
        d = d === Infinity ? dist : smin(d, dist, 34);
      }
      cloudGrid[gy * CLOUD_GRID + gx] = d;
    }
  }
}

function sampleCloud(x: number, y: number): number {
  const step = W / CLOUD_GRID;
  const fx = clamp(x / step - 0.5, 0, CLOUD_GRID - 1.001);
  const fy = clamp(y / step - 0.5, 0, CLOUD_GRID - 1.001);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * CLOUD_GRID + x0;
  const a = cloudGrid[i];
  const b = cloudGrid[i + 1];
  const c = cloudGrid[i + CLOUD_GRID];
  const dd = cloudGrid[i + CLOUD_GRID + 1];
  return mix(mix(a, b, tx), mix(c, dd, tx), ty);
}

// --- Foreground burst: bright puffs in front of the whale at the breach -----
const BURST_CIRCLES: CloudCircle[] = (() => {
  const rng = mulberry32(0xb527);
  const out: CloudCircle[] = [];
  for (let i = 0; i < 16; i++) {
    const ang = Math.PI * (0.08 + 0.84 * (i / 15)) + (rng() - 0.5) * 0.22;
    const dist = 18 + rng() * 74;
    out.push({
      x: BREACH_X + Math.cos(ang) * dist * 1.25,
      y: BREACH_Y + 10 - Math.sin(ang) * dist * 0.48,
      r: 15 + rng() * 40,
    });
  }
  out.push({ x: BREACH_X - 6, y: BREACH_Y + 10, r: 52 });
  out.push({ x: BREACH_X + 44, y: BREACH_Y + 18, r: 44 });
  return out;
})();

function burstD(x: number, y: number): number {
  let d = Infinity;
  for (const c of BURST_CIRCLES) {
    const dist = Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2) - c.r;
    if (dist < d) d = dist;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): Float32Array {
  buildCloudGrid();
  const img = new Float32Array(RW * RH * 3);
  const invSS = 1 / SS;

  for (let ry = 0; ry < RH; ry++) {
    const y = (ry + 0.5) * invSS;
    for (let rx = 0; rx < RW; rx++) {
      const x = (rx + 0.5) * invSS;
      const idx = (ry * RW + rx) * 3;

      // --- sky gradient + vignette ---
      const t = y / H;
      let col: RGB = t < 0.55 ? mixc(SKY_TOP, SKY_MID, smoothstep(0, 0.55, t)) : mixc(SKY_MID, SKY_DEEP, smoothstep(0.55, 1, t));
      const dxr = x - RING_X;
      const dyr = y - RING_Y;
      const distRing = Math.sqrt(dxr * dxr + dyr * dyr);
      const glow = Math.exp(-((distRing / 430) ** 2));
      col = [
        col[0] + TEAL_GLOW[0] * glow * 0.5 + GOLD_MID[0] * glow * glow * 0.16,
        col[1] + TEAL_GLOW[1] * glow * 0.5 + GOLD_MID[1] * glow * glow * 0.16,
        col[2] + TEAL_GLOW[2] * glow * 0.5 + GOLD_MID[2] * glow * glow * 0.16,
      ];
      const dcx = (x - W / 2) / (W * 0.72);
      const dcy = (y - H / 2) / (H * 0.72);
      const vig = 1 - 0.38 * smoothstep(0.55, 1.15, Math.sqrt(dcx * dcx + dcy * dcy));
      col = [col[0] * vig, col[1] * vig, col[2] * vig];

      // --- stars (grid-hash sparkle, only in the darker sky) ---
      const cell = 24;
      const cellX = Math.floor(x / cell);
      const cellY = Math.floor(y / cell);
      const sh = hash2(cellX, cellY);
      if (sh > 0.82) {
        const sx = (cellX + 0.2 + 0.6 * hash2(cellX + 91, cellY + 7)) * cell;
        const sy = (cellY + 0.2 + 0.6 * hash2(cellX + 3, cellY + 57)) * cell;
        const sd = Math.sqrt((x - sx) ** 2 + (y - sy) ** 2);
        const star = smoothstep(2.4, 0, sd) * (sh - 0.82) * 5.2 * (1 - glow) * (1 - t * 0.65);
        if (star > 0.003) {
          col = [col[0] + 0.75 * star, col[1] + 0.82 * star, col[2] + star];
        }
      }

      // --- god rays from the ring centre ---
      const ang = Math.atan2(dyr, dxr);
      const rayPat = Math.pow(0.5 + 0.5 * Math.sin(ang * 14 + 1.7), 6) + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(ang * 7 - 0.6), 10);
      const rayFall = Math.exp(-distRing / 640) * smoothstep(50, 250, distRing);
      const ray = rayPat * rayFall * 0.085;
      col = [col[0] + GOLD_MID[0] * ray, col[1] + GOLD_MID[1] * ray, col[2] + GOLD_MID[2] * ray];

      // --- the ring: halo, band, white-hot core ---
      const ad = Math.abs(distRing - RING_R);
      const angBright = 0.72 + 0.5 * (0.5 - 0.5 * Math.sin(ang));
      const halo = Math.exp(-(((ad / 115) ** 2) as number)) * 0.5;
      const mid = Math.exp(-((ad / 34) ** 2)) * 0.85;
      const core = Math.exp(-((ad / 13) ** 2)) * 1.65;
      col = [
        col[0] + (GOLD_DEEP[0] * halo + GOLD_MID[0] * mid + GOLD_CORE[0] * core) * angBright,
        col[1] + (GOLD_DEEP[1] * halo + GOLD_MID[1] * mid + GOLD_CORE[1] * core) * angBright,
        col[2] + (GOLD_DEEP[2] * halo + GOLD_MID[2] * mid + GOLD_CORE[2] * core) * angBright,
      ];

      // --- cloud sea (back layer): a lit rolling deck sinking into fog ---
      if (y > 480) {
        const surfY = cloudSurf(x);
        const dSurf = y - surfY; // signed depth below the surface line
        const d = sampleCloud(x, y);
        // Coverage from the billow SDF near the edge; well below the surface
        // the deck is simply solid.
        const eroFull = (fbm(x * 0.016, y * 0.016, 3) - 0.5) * 52 + (vnoise(x * 0.05, y * 0.05) - 0.5) * 18;
        const deff = d + eroFull * clamp(1 - Math.abs(d) / 110, 0, 1);
        let cov = clamp(0.5 - deff * SS, 0, 1);
        cov = Math.max(cov, smoothstep(55, 115, dSurf));
        if (cov > 0) {
          // Up-facing light from the SDF gradient, near the surface only.
          const e = 3;
          const gy = sampleCloud(x, y + e) - sampleCloud(x, y - e);
          const gx = sampleCloud(x + e, y) - sampleCloud(x - e, y);
          const gl = Math.sqrt(gx * gx + gy * gy) || 1;
          const up = clamp(-(gy / gl), 0, 1);
          const distBreach = Math.sqrt((x - BREACH_X) ** 2 + (y - BREACH_Y) ** 2);
          const goldProx = clamp(Math.exp(-distRing / 560) + 0.9 * Math.exp(-distBreach / 330), 0, 1.25);
          // Fog by depth below the surface line: a gold-lit teal skin,
          // mottled mid-tones, then deep blue dark. No second surface exists
          // down there, so nothing can catch a false highlight.
          const depthT = clamp(dSurf / 175, 0, 1);
          const light = (0.36 + 1.0 * up * goldProx) * (1 - depthT * 0.72);
          const mottle = 0.84 + 0.3 * fbm(x * 0.006 + 7, y * 0.006, 3) + (fbm(x * 0.021, y * 0.021, 2) - 0.5) * 0.12;
          let cc = mixc(CLOUD_MID, CLOUD_LIT, clamp(light - 0.3, 0, 1) * 0.44);
          cc = [cc[0] * mottle, cc[1] * mottle, cc[2] * mottle];
          cc = mixc(cc, CLOUD_DEEP, smoothstep(0.05, 0.9, depthT));
          // Bright lip hugging the true (SDF) surface skin, lit side only.
          const lip = Math.pow(clamp(1 - Math.abs(deff) / 20, 0, 1), 2) * up * goldProx * 0.85;
          cc = mixc(cc, CLOUD_HI, clamp(lip, 0, 1));
          // Mist strata far below: two soft, noise-broken bands of paler
          // fog, so the lower frame has depth instead of a flat fill.
          if (depthT > 0.3) {
            const band =
              Math.exp(-(((y - 848) / 26) ** 2)) * 0.05 + Math.exp(-(((y - 940) / 32) ** 2)) * 0.04;
            const broken = 0.4 + 0.6 * fbm(x * 0.009 + 31, y * 0.002, 2);
            const mist = band * broken * smoothstep(0.3, 0.65, depthT);
            cc = [cc[0] + 0.3 * mist, cc[1] + 0.48 * mist, cc[2] + 0.52 * mist];
          }
          col = mixc(col, cc, cov);
        }
      }

      // --- the whale ---
      if (x > 90 && x < 900 && y > 120 && y < 900) {
        const d = whaleD(x, y);
        if (d < 4) {
          const cov = clamp(0.5 - d * SS, 0, 1);
          if (cov > 0) {
            const shade = 0.82 + 0.36 * clamp((y - 180) / 560, 0, 1) + (fbm(x * 0.008, y * 0.008, 2) - 0.5) * 0.14;
            let wc: RGB = [WHALE_BASE[0] * shade, WHALE_BASE[1] * shade, WHALE_BASE[2] * shade];
            const belly = smoothstep(0.1, 0.9, (y - 300) / 380) * 0.35;
            wc = mixc(wc, WHALE_BELLY, belly * clamp(-d / 60, 0, 1));
            // Rim light from the ring, strongest on the edge facing it.
            if (d > -4.5) {
              const e = 1.6;
              const gx = whaleD(x + e, y) - whaleD(x - e, y);
              const gy = whaleD(x, y + e) - whaleD(x, y - e);
              const gl = Math.sqrt(gx * gx + gy * gy) || 1;
              const nx = gx / gl;
              const ny = gy / gl;
              let lx = RING_X - x;
              let ly = RING_Y - y;
              const ll = Math.sqrt(lx * lx + ly * ly) || 1;
              lx /= ll;
              ly /= ll;
              const facing = Math.pow(clamp(nx * lx + ny * ly, 0, 1), 1.6);
              const rim = Math.pow(clamp(1 - Math.abs(d) / 3.6, 0, 1), 2) * (0.25 + 0.95 * facing);
              wc = [
                wc[0] + RIM_GOLD[0] * rim * 0.85,
                wc[1] + RIM_GOLD[1] * rim * 0.85,
                wc[2] + RIM_GOLD[2] * rim * 0.85,
              ];
            }
            col = mixc(col, wc, cov);
          }
        }
      }

      // --- foreground burst puffs at the breach ---
      if (x > 210 && x < 500 && y > 540 && y < 800) {
        const d = burstD(x, y);
        if (d < 30) {
          const ero = (fbm(x * 0.03 + 9, y * 0.03, 3) - 0.5) * 24 + (vnoise(x * 0.09, y * 0.09) - 0.5) * 10;
          const deff = d + ero;
          const cov = clamp(0.5 - deff * SS, 0, 1);
          if (cov > 0) {
            const depth = clamp(-deff / 55, 0, 1);
            let bc = mixc(CLOUD_HI, CLOUD_LIT, depth * 0.75);
            const mottle = 0.88 + 0.24 * fbm(x * 0.03 + 3, y * 0.03, 2);
            bc = [bc[0] * mottle, bc[1] * mottle, bc[2] * mottle];
            const top = clamp(1 - -deff / 15, 0, 1);
            bc = mixc(bc, [1.0, 0.98, 0.9], top * 0.6);
            col = mixc(col, bc, cov);
          }
        }
      }

      // --- the tiny human ---
      if (x > 655 && x < 765 && y > 495 && y < 625) {
        const d = humanD(x, y);
        if (d < 3) {
          const cov = clamp(0.5 - d * SS, 0, 1);
          if (cov > 0) {
            let hc: RGB = [...HUMAN_BASE];
            if (d > -3.2) {
              const e = 1.2;
              const gx = humanD(x + e, y) - humanD(x - e, y);
              const gy = humanD(x, y + e) - humanD(x, y - e);
              const gl = Math.sqrt(gx * gx + gy * gy) || 1;
              let lx = RING_X - x;
              let ly = RING_Y - y;
              const ll = Math.sqrt(lx * lx + ly * ly) || 1;
              lx /= ll;
              ly /= ll;
              const facing = Math.pow(clamp((gx / gl) * lx + (gy / gl) * ly, 0, 1), 1.5);
              const rim = Math.pow(clamp(1 - Math.abs(d) / 2.6, 0, 1), 2) * (0.2 + 1.0 * facing);
              hc = [hc[0] + RIM_GOLD[0] * rim, hc[1] + RIM_GOLD[1] * rim, hc[2] + RIM_GOLD[2] * rim];
            }
            col = mixc(col, hc, cov);
          }
        }
      }

      img[idx] = col[0];
      img[idx + 1] = col[1];
      img[idx + 2] = col[2];
    }
  }

  // --- particles: spray, motes, streaks (additive splats, seeded) ---
  const splat = (fx: number, fy: number, radius: number, r: number, g: number, b: number, alpha: number): void => {
    const cx = fx * SS;
    const cy = fy * SS;
    const rad = Math.max(radius * SS, 0.75);
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(RW - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(RH - 1, Math.ceil(cy + rad));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dd = Math.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / rad;
        if (dd >= 1) continue;
        const fall = (1 - dd * dd) * alpha;
        const i = (yy * RW + xx) * 3;
        img[i] += r * fall;
        img[i + 1] += g * fall;
        img[i + 2] += b * fall;
      }
    }
  };

  const rng = mulberry32(0x5eed);
  // Spray bursting upward from the breach point.
  for (let i = 0; i < 320; i++) {
    const t = rng();
    const spread = (rng() - 0.5) * 1.15;
    const dirx = 0.25 + spread * 0.7;
    const diry = -1 + Math.abs(spread) * 0.24;
    const dl = Math.sqrt(dirx * dirx + diry * diry);
    const speed = 55 + rng() * 235;
    const px = BREACH_X + (dirx / dl) * speed * Math.pow(t, 0.8);
    const py = BREACH_Y + (diry / dl) * speed * Math.pow(t, 0.8) + 150 * t * t;
    const size = (1 - t) * 3.1 + 0.7;
    const alpha = ((1 - t) * 0.7 + 0.16) * 0.9;
    splat(px, py, size, 1.0, 0.88, 0.66, alpha);
  }
  // Drifting motes in the light.
  for (let i = 0; i < 140; i++) {
    const px = rng() * W;
    const py = rng() * H * 0.78;
    const warm = rng() > 0.4;
    const alpha = 0.05 + rng() * 0.15;
    if (warm) splat(px, py, 0.8 + rng() * 1.1, 1.0, 0.8, 0.5, alpha);
    else splat(px, py, 0.8 + rng() * 1.1, 0.55, 0.85, 0.95, alpha);
  }
  // Speed streaks trailing the whale's rise.
  for (let i = 0; i < 36; i++) {
    const bx = 190 + rng() * 620;
    const by = 190 + rng() * 560;
    const len = 16 + rng() * 40;
    const steps = Math.floor(len / 2);
    for (let sIdx = 0; sIdx <= steps; sIdx++) {
      const f = sIdx / steps;
      splat(bx - 0.62 * len * f, by + 0.78 * len * f, 1.15, 1.0, 0.85, 0.6, 0.075 * (1 - f * 0.6));
    }
  }
  // Droplets shedding off the whale's belly and tail, mid-fall.
  for (let i = 0; i < 110; i++) {
    const s = SPINE[Math.floor(rng() * SPINE.length * 0.72)];
    const px = s.x + (rng() - 0.5) * s.r * 1.5;
    const py = s.y + s.r * (0.55 + rng() * 0.4) + rng() * rng() * 120;
    splat(px, py, 0.8 + rng() * 1.6, 0.95, 0.85, 0.66, 0.35 + rng() * 0.45);
  }
  // The lantern: halo + hot core.
  splat(LANTERN_X, LANTERN_Y, 30, 1.0, 0.78, 0.42, 0.22);
  splat(LANTERN_X, LANTERN_Y, 10, 1.0, 0.85, 0.55, 0.55);
  splat(LANTERN_X, LANTERN_Y, 3.4, 1.0, 0.95, 0.8, 1.0);

  return img;
}

// ---------------------------------------------------------------------------
// Downsample, tone map, grain, write
// ---------------------------------------------------------------------------

function finish(img: Float32Array): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * RW + (x * SS + sx)) * 3;
          r += img[i];
          g += img[i + 1];
          b += img[i + 2];
        }
      }
      const n = SS * SS;
      r /= n;
      g /= n;
      b /= n;
      // Soft filmic shoulder so additive glows roll off instead of clipping.
      r = 1 - Math.exp(-r * 1.5);
      g = 1 - Math.exp(-g * 1.5);
      b = 1 - Math.exp(-b * 1.5);
      // Seeded grain: dithers the gradients so they never band.
      const grain = (hash2(x * 3 + 11, y * 5 + 29) - 0.5) * 0.011;
      const o = (y * W + x) * 3;
      out[o] = Math.round(clamp(r + grain, 0, 1) * 255);
      out[o + 1] = Math.round(clamp(g + grain, 0, 1) * 255);
      out[o + 2] = Math.round(clamp(b + grain, 0, 1) * 255);
    }
  }
  return out;
}

function main(): void {
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const img = render();
  const rgb = finish(img);
  const png = encodePNG(rgb, W, H);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'entry.png'), png);
}

main();
