// The Book That Contained the Sea
//
// A procedural painting drawn entirely in code: a dark library at night,
// an open book glowing gold on a wooden table, and a towering indigo wave
// erupting from its pages. A tiny lighthouse stands on the left page; a
// tiny reader leaps back as a chair topples and loose pages flutter through
// the spray. Warm gold against deep blue shadow, painterly, diagonal.
//
// Node 22, standard library only. Seeded randomness throughout: two runs
// produce byte-identical output.
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------- deterministic randomness ----------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x51ab00c);
function rr(a: number, b: number): number {
  return a + rand() * (b - a);
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ---------------- value noise ----------------
function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}
function sm(t: number): number {
  return t * t * (3 - 2 * t);
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const u = sm(fx);
  const v = sm(fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, oct: number): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

// ---------------- canvas ----------------
const W = 1024;
const H = 1024;
const buf = new Float32Array(W * H * 3);
type C = [number, number, number];
type Pt = [number, number];

function mix(a: C, b: C, t: number): C {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function shade(c: C, f: number): C {
  return [c[0] * f, c[1] * f, c[2] * f];
}

function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] += (r - buf[i]) * a;
  buf[i + 1] += (g - buf[i + 1]) * a;
  buf[i + 2] += (b - buf[i + 2]) * a;
}

// Soft-edged ellipse, optionally rotated.
function blob(cx: number, cy: number, rx: number, ry: number, rot: number, c: C, a: number, feather = 0.4): void {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const half = Math.hypot(rx, ry) + 2;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(W - 1, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(H - 1, Math.ceil(cy + half));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (cos * dx + sin * dy) / rx;
      const v = (-sin * dx + cos * dy) / ry;
      const d = u * u + v * v;
      if (d >= 1) continue;
      let e = (1 - d) / feather;
      if (e > 1) e = 1;
      e = e * e * (3 - 2 * e);
      blend(x, y, c[0], c[1], c[2], a * e);
    }
  }
}

function disc(cx: number, cy: number, r: number, c: C, a: number): void {
  blob(cx, cy, r, r, 0, c, a, 0.35);
}

// Soft radial glow.
function glow(cx: number, cy: number, rad: number, c: C, a: number, power = 2): void {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad;
      if (d >= 1) continue;
      const f = Math.pow(1 - d, power);
      blend(x, y, c[0], c[1], c[2], a * f);
    }
  }
}

// Scanline polygon fill (even-odd).
function poly(pts: Pt[], c: C, a: number): void {
  let minY = 1e9;
  let maxY = -1e9;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if ((p[1] <= yc && q[1] > yc) || (q[1] <= yc && p[1] > yc)) {
        const t = (yc - p[1]) / (q[1] - p[1]);
        xs.push(p[0] + t * (q[0] - p[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blend(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Rotated rectangle centred at (cx, cy).
function quad(cx: number, cy: number, w: number, h: number, angle: number, c: C, a: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = w / 2;
  const hh = h / 2;
  const corners: Pt[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([lx, ly]): Pt => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
  poly(corners, c, a);
}

// Thick soft line segment.
function seg(x0: number, y0: number, x1: number, y1: number, w: number, c: C, a: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const pad = w / 2 + 3;
  const xa = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const xb = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + pad));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const yb = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + pad));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let t = ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const px = x0 + t * dx;
      const py = y0 + t * dy;
      const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
      if (d >= w / 2 + 1.5) continue;
      let e = (w / 2 + 1.5 - d) / 3;
      if (e > 1) e = 1;
      e = e * e * (3 - 2 * e);
      blend(x, y, c[0], c[1], c[2], a * e);
    }
  }
}

function vgrad(x0: number, y0: number, x1: number, y1: number, top: C, bot: C): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0 - 1);
    const r = top[0] + (bot[0] - top[0]) * t;
    const g = top[1] + (bot[1] - top[1]) * t;
    const b = top[2] + (bot[2] - top[2]) * t;
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
}

function rect(x0: number, y0: number, x1: number, y1: number, c: C, a: number): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) blend(x, y, c[0], c[1], c[2], a);
  }
}

// Catmull-Rom spline through control points.
function catmull(pts: Pt[], per: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------- scene ----------------
const GOLD: C = [232, 182, 96];
const GOLD_HI: C = [255, 216, 132];
const CREAM: C = [236, 221, 182];
const INDIGO: C = [12, 26, 62];
const INDIGO_MID: C = [18, 48, 92];
const TEAL: C = [48, 112, 142];
const FOAM: C = [240, 244, 250];
const DARK: C = [10, 12, 22];

function paintBackground(): void {
  vgrad(0, 0, W, H, [11, 14, 30], [4, 5, 12]);
  // Mottled wall texture, subtle.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = fbm(x * 0.012, y * 0.012, 2);
      const m = 0.93 + 0.14 * n;
      const i = (y * W + x) * 3;
      buf[i] *= m;
      buf[i + 1] *= m;
      buf[i + 2] *= m;
    }
  }
  // Cool moonlit wash high on the wall, very faint.
  glow(512, 90, 520, [46, 66, 110], 0.16, 2);
}

const BOOK_COLORS: C[] = [
  [96, 52, 44],
  [74, 88, 110],
  [110, 96, 60],
  [88, 74, 66],
  [70, 96, 70],
  [120, 84, 96],
  [60, 70, 84],
  [140, 110, 70],
  [100, 64, 84],
  [84, 100, 92],
];

function paintShelves(): void {
  const rows = [36, 176, 316, 456, 596, 736];
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 10 : 834;
    const x1 = side === 0 ? 190 : 1014;
    // Shelf carcass.
    rect(x0 - 4, 20, x1 + 4, 812, [24, 15, 9], 1);
    rect(x0, 20, x1, 812, [14, 9, 5], 1);
    for (const ry of rows) {
      // Books on this shelf.
      let x = x0 + 4;
      const boardY = ry + 132;
      while (x < x1 - 18) {
        const bw = rr(15, 30);
        const bh = rr(86, 128);
        const base = pick(BOOK_COLORS);
        const dim = rr(0.42, 0.8);
        const col = shade(base, dim);
        const lean = rand() < 0.09;
        if (lean) {
          quad(x + bw / 2, boardY - bh / 2, bw, bh, 0.16, col, 1);
        } else {
          rect(x, boardY - bh, x + bw, boardY, col, 1);
          // Lighter top edge and a band.
          rect(x, boardY - bh, x + bw, boardY - bh + 2, shade(col, 1.35), 0.7);
          if (rand() < 0.55) {
            rect(x, boardY - bh + rr(24, 44), x + bw, boardY - bh + rr(26, 48), shade(col, 1.5), 0.5);
          }
        }
        x += bw + rr(0, 3);
      }
      // A flat stack on some shelves.
      if (rand() < 0.5) {
        const sx = x0 + rr(20, 90);
        const sw = rr(56, 84);
        rect(sx, boardY - 26, sx + sw, boardY - 14, shade(pick(BOOK_COLORS), rr(0.4, 0.7)), 1);
        rect(sx + 4, boardY - 38, sx + sw - 6, boardY - 26, shade(pick(BOOK_COLORS), rr(0.4, 0.7)), 1);
      }
      // Shelf board.
      rect(x0, boardY, x1, boardY + 9, [40, 26, 15], 1);
      rect(x0, boardY + 9, x1, boardY + 11, [18, 11, 6], 1);
    }
    // Dim the whole shelf unit toward the dark room.
    rect(x0 - 4, 20, x1 + 4, 812, [6, 7, 14], 0.22);
  }
}

function paintTable(): void {
  vgrad(0, 800, W, H, [66, 38, 20], [28, 15, 8]);
  // Horizontal wood grain.
  for (let y = 800; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = fbm(x * 0.006, y * 0.055, 2);
      const m = 0.9 + 0.2 * n;
      const i = (y * W + x) * 3;
      buf[i] *= m;
      buf[i + 1] *= m;
      buf[i + 2] *= m;
    }
  }
  // Plank seams and a couple of knots.
  for (const sx of [248, 522, 792]) {
    seg(sx, 802, sx + 14, 1024, 3, [16, 8, 4], 0.3);
  }
  blob(300, 950, 26, 9, 0.2, [20, 10, 5], 0.5);
  blob(760, 1010, 30, 10, -0.15, [20, 10, 5], 0.45);
  // Front edge highlight.
  seg(0, 800, W, 800, 2, [126, 84, 46], 0.55);
  // Warm pool of light around the book.
  glow(512, 884, 430, GOLD, 0.3, 2);
  // A small stack of books resting on the table, left of the open book.
  quad(238, 916, 96, 14, 0.02, shade([74, 88, 110], 0.7), 1);
  quad(240, 900, 88, 14, -0.03, shade([96, 52, 44], 0.75), 1);
  quad(242, 885, 78, 13, 0.04, shade([110, 96, 60], 0.7), 1);
}

function paintLightWash(): void {
  // Diffuse golden wash rising from the book, and faint cool rim above.
  blob(320, 480, 250, 330, 0.15, GOLD, 0.07, 0.6);
  blob(760, 300, 220, 260, -0.1, [70, 100, 150], 0.06, 0.6);
}

function paintBook(): void {
  // Under-glow first, so the pages sit in the light.
  glow(512, 892, 170, GOLD_HI, 0.85, 2);
  glow(512, 892, 300, GOLD, 0.4, 2);
  // Covers (dark red-brown) peeking out from under the pages.
  poly(
    [
      [376, 856],
      [512, 836],
      [512, 956],
      [382, 964],
    ],
    [74, 30, 22],
    1,
  );
  poly(
    [
      [512, 836],
      [648, 856],
      [642, 964],
      [512, 956],
    ],
    [74, 30, 22],
    1,
  );
  // Pages.
  poly(
    [
      [386, 860],
      [512, 842],
      [512, 950],
      [392, 958],
    ],
    CREAM,
    1,
  );
  poly(
    [
      [512, 842],
      [640, 860],
      [634, 958],
      [512, 950],
    ],
    CREAM,
    1,
  );
  // Bright core near the spine: the light lives in the book.
  glow(512, 895, 105, [255, 226, 150], 0.5, 2);
  // Spine shadow.
  seg(512, 840, 512, 954, 4, [60, 38, 18], 0.6);
  // Faint lines of text on the pages.
  for (const side of [0, 1]) {
    for (let k = 0; k < 5; k++) {
      const y = 872 + k * 14;
      const xA = side === 0 ? 406 + k * 2 : 530 + k * 1;
      const xB = side === 0 ? 500 - k * 3 : 624 - k * 2;
      seg(xA, y, xB, y + (side === 0 ? -3 : 3), 1.6, [120, 100, 70], 0.4);
    }
  }
}

function paintLighthouse(): void {
  // A tiny lighthouse, impossibly real, standing on the left page.
  // Soft shadow on the page.
  blob(452, 852, 12, 3.5, 0, [30, 20, 10], 0.4);
  // Rock base.
  blob(452, 849, 11, 5, 0, [52, 48, 44], 1);
  // Tower: white with two red bands.
  poly(
    [
      [446, 850],
      [458, 850],
      [456, 818],
      [448, 818],
    ],
    [236, 234, 224],
    1,
  );
  poly(
    [
      [447, 840],
      [457, 840],
      [456.6, 832],
      [447.4, 832],
    ],
    [172, 52, 42],
    1,
  );
  poly(
    [
      [448, 826],
      [456, 826],
      [455.6, 820],
      [448.4, 820],
    ],
    [172, 52, 42],
    1,
  );
  // Lamp room and its light.
  rect(447, 813, 457, 819, [18, 16, 14], 1);
  disc(452, 811, 3, GOLD_HI, 1);
  glow(452, 811, 16, GOLD_HI, 0.8, 2);
  // A narrow beam sweeping up-left across the room.
  poly(
    [
      [452, 811],
      [372, 748],
      [386, 776],
    ],
    GOLD_HI,
    0.16,
  );
}

function paintWave(): void {
  const ctrl: Pt[] = [
    [560, 918],
    [548, 800],
    [512, 645],
    [472, 495],
    [468, 360],
    [512, 252],
    [600, 178],
    [708, 162],
    [798, 212],
    [848, 300],
    [846, 392],
  ];
  const widths = [196, 186, 162, 148, 136, 124, 110, 96, 80, 64, 50];
  const spine = catmull(ctrl, 12);
  const n = spine.length;
  const hollow: Pt = [705, 335];

  // Pass A — the water body, overlapping soft blobs along the spine.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [x, y] = spine[i];
    const w = widths[Math.min(widths.length - 1, Math.floor(t * (widths.length - 1)))];
    const r = w / 2;
    const nx = spine[Math.min(n - 1, i + 1)][0] - spine[Math.max(0, i - 1)][0];
    const ny = spine[Math.min(n - 1, i + 1)][1] - spine[Math.max(0, i - 1)][1];
    const ang = Math.atan2(ny, nx);
    const streak = fbm(t * 8.0, 0.63, 2);
    let col = mix(INDIGO, INDIGO_MID, Math.min(1, Math.max(0, 0.2 + 0.7 * streak)));
    col = mix(col, TEAL, Math.min(1, Math.max(0, (streak - 0.42) * 1.4)) * 0.35);
    let goldF = (y - 620) / 300;
    if (goldF < 0) goldF = 0;
    if (goldF > 1) goldF = 1;
    goldF *= goldF;
    col = mix(col, GOLD, goldF * 0.42);
    col = mix(col, [70, 120, 158], t * 0.1);
    blob(x, y, r * 1.28, r * 0.96, ang, col, 0.92, 0.45);
  }

  // Pass B — the dark hollow inside the curl.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (t < 0.52) continue;
    const [x, y] = spine[i];
    const w = widths[Math.min(widths.length - 1, Math.floor(t * (widths.length - 1)))];
    const r = w / 2;
    let dx = hollow[0] - x;
    let dy = hollow[1] - y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    blob(x + dx * r * 0.42, y + dy * r * 0.42, r * 0.62, r * 0.58, 0, [9, 17, 40], 0.6, 0.5);
  }

  // Pass C — foam lace along the crest and the inner lip.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (t < 0.58) continue;
    const [x, y] = spine[i];
    const w = widths[Math.min(widths.length - 1, Math.floor(t * (widths.length - 1)))];
    const r = w / 2;
    let dx = hollow[0] - x;
    let dy = hollow[1] - y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Outer crest edge.
    blob(x - dx * r * 0.95 + rr(-6, 6), y - dy * r * 0.95 + rr(-6, 6), rr(3, 9), rr(2.5, 7), rr(0, 3), FOAM, rr(0.6, 0.95), 0.4);
    // Inner lip.
    blob(x + dx * r * 0.72 + rr(-4, 4), y + dy * r * 0.72 + rr(-4, 4), rr(2.5, 7), rr(2, 6), rr(0, 3), mix(FOAM, GOLD_HI, 0.25), rr(0.55, 0.9), 0.4);
  }

  // Pass D — cool rim light on the outer edge of the rising column.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (t > 0.62) continue;
    const [x, y] = spine[i];
    const w = widths[Math.min(widths.length - 1, Math.floor(t * (widths.length - 1)))];
    const r = w / 2;
    let dx = x - hollow[0];
    let dy = y - hollow[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    blob(x + dx * r * 0.88, y + dy * r * 0.88, rr(2, 4.5), rr(1.5, 3.5), 0, [150, 190, 220], 0.16, 0.5);
  }

  // Pass E — the burst where the water leaves the book.
  for (let k = 0; k < 14; k++) {
    const a = rr(0, Math.PI * 2);
    const d = Math.pow(rand(), 0.6) * 70;
    const x = 540 + Math.cos(a) * d;
    const y = 880 + Math.sin(a) * d * 0.7;
    const col = rand() < 0.5 ? mix(FOAM, GOLD_HI, 0.45) : mix(GOLD_HI, FOAM, 0.3);
    blob(x, y, rr(8, 34), rr(6, 24), rr(0, 3), col, rr(0.12, 0.32), 0.5);
  }
}

function paintSpray(): void {
  // Droplets around the crest.
  for (let k = 0; k < 750; k++) {
    const a = rr(0, Math.PI * 2);
    const d = 280 * Math.pow(rand(), 1.6);
    const x = 740 + Math.cos(a) * d * 1.15;
    const y = 215 + Math.sin(a) * d * 0.85;
    const col = rand() < 0.8 ? [210, 228, 248] : GOLD_HI;
    disc(x, y, rr(0.7, 2.6), col, rr(0.1, 0.65));
  }
  // Droplets bursting from the book.
  for (let k = 0; k < 420; k++) {
    const a = rr(0, Math.PI * 2);
    const d = 190 * Math.pow(rand(), 1.4);
    const x = 540 + Math.cos(a) * d;
    const y = 855 + Math.sin(a) * d * 0.7;
    const col = rand() < 0.55 ? [240, 212, 150] : [214, 230, 246];
    disc(x, y, rr(0.7, 2.4), col, rr(0.1, 0.6));
  }
  // A few fast streaks near the crest.
  for (let k = 0; k < 46; k++) {
    const x = rr(560, 940);
    const y = rr(120, 380);
    const ang = rr(-0.9, 0.4);
    const len = rr(10, 34);
    seg(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, rr(1, 2.2), [220, 232, 248], rr(0.15, 0.45));
  }
}

function paintPage(cx: number, cy: number, w: number, h: number, angle: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = w / 2;
  const hh = h / 2;
  const corner = (lx: number, ly: number): Pt => [
    cx + lx * cos - ly * sin,
    cy + lx * sin + ly * cos,
  ];
  const pts: Pt[] = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
  // Soft shadow.
  const sh: Pt[] = pts.map(([x, y]): Pt => [x + 5, y + 6]);
  poly(sh, [8, 6, 4], 0.35);
  poly(pts, CREAM, 1);
  // Folded corner.
  poly([corner(hw, hh), corner(hw - 12, hh), corner(hw, hh - 12)], [196, 176, 132], 1);
  // Lines of text.
  for (let k = 0; k < 3; k++) {
    const ly = -hh + 12 + k * 10;
    const p1 = corner(-hw + 7, ly);
    const p2 = corner(hw - 7, ly + 2);
    seg(p1[0], p1[1], p2[0], p2[1], 1.4, [122, 102, 72], 0.5);
  }
}

function paintPages(): void {
  const pages: [number, number, number, number, number][] = [
    [690, 300, 42, 56, -0.42],
    [770, 430, 40, 54, 0.21],
    [645, 250, 38, 52, 0.66],
    [835, 345, 44, 58, -0.14],
    [395, 430, 40, 54, 0.31],
    [735, 530, 42, 56, -0.52],
    [890, 490, 38, 52, 0.1],
    [565, 335, 36, 50, -0.24],
  ];
  for (const [x, y, w, h, a] of pages) paintPage(x, y, w, h, a);
}

function paintReaderChair(): void {
  // The tiny reader, leaping back in shock — dark silhouette, gold rim.
  const dark: C = [13, 11, 19];
  const rim: C = [214, 168, 92];
  const ox = 2;
  const oy = 2;
  // Rim pass (offset copy).
  seg(838 + ox, 880 + oy, 836 + ox, 906 + oy, 7, rim, 0.5);
  seg(838 + ox, 884 + oy, 820 + ox, 866 + oy, 5, rim, 0.5);
  seg(838 + ox, 884 + oy, 856 + ox, 864 + oy, 5, rim, 0.5);
  seg(836 + ox, 906 + oy, 824 + ox, 930 + oy, 5, rim, 0.5);
  seg(836 + ox, 906 + oy, 850 + ox, 932 + oy, 5, rim, 0.5);
  disc(838 + ox, 872 + oy, 7, rim, 0.5);
  // Body.
  seg(838, 880, 836, 906, 7, dark, 1);
  seg(838, 884, 820, 866, 5, dark, 1);
  seg(838, 884, 856, 864, 5, dark, 1);
  seg(836, 906, 824, 930, 5, dark, 1);
  seg(836, 906, 850, 932, 5, dark, 1);
  disc(838, 872, 7, dark, 1);
  // Motion streaks behind the leap.
  seg(812, 900, 796, 912, 2, [200, 190, 170], 0.3);
  seg(816, 918, 800, 932, 2, [200, 190, 170], 0.25);

  // The toppled chair, lying on its side, legs in the air.
  const wood: C = [74, 48, 27];
  const edge: C = [150, 104, 58];
  quad(906, 942, 46, 10, -0.9, wood, 1);
  quad(884, 928, 10, 42, -0.9, wood, 1);
  seg(888, 936, 868, 906, 4, wood, 1);
  seg(896, 940, 884, 908, 4, wood, 1);
  seg(918, 948, 936, 916, 4, wood, 1);
  seg(924, 944, 946, 920, 4, wood, 1);
  seg(888, 936, 868, 906, 1.6, edge, 0.6);
  seg(918, 948, 936, 916, 1.6, edge, 0.6);
}

// ---------------- PNG encoder (own implementation) ----------------
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
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

function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestCost = Infinity;
    let best: Uint8Array = new Uint8Array(stride);
    for (let t = 0; t < 5; t++) {
      const f = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const left = i >= 3 ? row[i - 3] : 0;
        const up = prev[i];
        const upLeft = i >= 3 ? prev[i - 3] : 0;
        let v = row[i];
        if (t === 1) v = row[i] - left;
        else if (t === 2) v = row[i] - up;
        else if (t === 3) v = row[i] - Math.floor((left + up) / 2);
        else if (t === 4) v = row[i] - paeth(left, up, upLeft);
        f[i] = v & 0xff;
      }
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const s = f[i] > 127 ? f[i] - 256 : f[i];
        cost += s < 0 ? -s : s;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
        best = f;
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- main ----------------
function main(): void {
  paintBackground();
  paintShelves();
  paintTable();
  paintLightWash();
  paintBook();
  paintLighthouse();
  paintWave();
  paintSpray();
  paintPages();
  paintReaderChair();

  // Vignette: darken the corners so the centre glows.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - W / 2) / (W / 2);
      const dy = (y + 0.5 - H / 2) / (H / 2);
      const d2 = dx * dx + dy * dy;
      let v = (d2 - 0.5) / 0.9;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      const f = 1 - 0.45 * Math.pow(v, 1.5);
      const i = (y * W + x) * 3;
      buf[i] *= f;
      buf[i + 1] *= f;
      buf[i + 2] *= f;
    }
  }

  // Film grain (its own seeded stream, so it is deterministic too).
  const grain = mulberry32(0x9e3779b9);
  const GRAIN = 2;
  for (let i = 0; i < W * H * 3; i++) {
    buf[i] += (grain() - 0.5) * GRAIN;
  }

  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) {
    const v = buf[i];
    rgb[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  const png = encodePNG(W, H, rgb);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'entry.png');
  writeFileSync(outPath, png);
  const hash = createHash('sha256').update(png).digest('hex');
  console.log(`entry.png ${W}x${H} ${png.length} bytes sha256=${hash}`);
}

main();
