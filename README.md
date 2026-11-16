# skybreach

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

**THE BOOK THAT CONTAINED THE SEA** — a single image, drawn entirely in code
by one Node program. No image assets, no libraries: every pixel is computed.

## The image

A dark old library at night: tall shadowed bookshelves to the left and right,
a wooden table in the foreground. On the table lies an open book, its pages
glowing warm gold — and out of the book a towering ocean wave is erupting,
curling over the whole room at the peak of its break. The water is deep indigo
shot through with molten-gold filaments and tiny stars; the crest is breaking
into ragged foam and spray, loose pages flutter among the droplets, and spray
flies toward the viewer. On the book's other page stands a tiny lighthouse,
its beam cutting through the spray. At the table's edge a tiny reader leaps
back in shock, chair toppling behind them. The wave fills the upper
two-thirds of the frame on a rising diagonal, the gold crest is the brightest
point, and the scene still reads at 300 pixels across: bright curl, glowing
book, dark shelves, one small startled figure.

## How it is drawn

`main.ts` (Node 22, standard library only) is a small painterly renderer:

- The wave is a Catmull-Rom spine swept with a tapering radius — narrow
  where it bursts from the pages, swelling as it climbs, curling over into
  the break — precomputed into distance / spine-parameter / radius grids.
  Per pixel it is shaded in layers: a deep indigo body with a thinner lit
  teal shell, flow streaks that run along the tube, ridged-noise gold
  filaments, specular glints, and foam (surface band, crest cap, the lining
  of the curl's throat, base churn) broken into ragged clumps by multi-scale
  fractal noise so it never forms a clean outline.
- The room is built from shaded shapes: a seeded bookshelf layout (varied
  muted spines, gilt bands, warm rim light on the inner edges), a wooden
  table with a pool of book-light and the wave's soft shadow, a stack of
  closed books, and the open book itself as two glowing page quads with
  curl shading.
- The lighthouse, the leaping reader and the toppling chair are
  capsule/box SDF silhouettes with rim light computed from the SDF gradient
  toward the book's glow; the lighthouse beam is an analytic soft wedge
  with dust motes drifting in it.
- Spray off the crest, droplet streaks off the tip, base splash, stars
  embedded in the wave body, ambient motes and big soft foreground
  droplets are additive splats, all placed by a fixed-seed PRNG
  (mulberry32) — never `Math.random` or the clock — so two runs produce
  byte-identical output.
- The scene is rendered at 2x supersampling and box-downsampled, given a
  filmic shoulder and seeded grain so the gradients never band, then
  written by a hand-rolled PNG encoder (CRC32, per-row best-filter
  selection, zlib deflate) as a 1024x1024 RGB PNG of about 1.0 MB.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Writes `entry.png` into the output directory in a few seconds.
