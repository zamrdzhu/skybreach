# skybreach

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

**THE BOOK THAT CONTAINED THE SEA** — one picture, drawn entirely by a single
Node program. There are no image assets and no libraries: every pixel of the
1024x1024 PNG is computed from fields, shapes and seeded noise.

## The image

Night in an old library. Tall bookshelves stand in shadow to the left and
right; a wooden table fills the foreground. On the table an open book glows
warm gold — and the sea that was inside it is coming out: a towering wave
erupts from the pages and curls over the whole room at the very peak of its
break. The water is deep indigo threaded with molten-gold filaments and tiny
stars; the crest shatters into ragged foam, spray and fluttering loose pages
that fly toward the viewer. On the facing page a tiny lighthouse keeps its
beam cutting through the spray, and at the table's edge a tiny reader leaps
back in shock, chair toppling behind them. The wave takes the upper
two-thirds of the frame on a rising diagonal, the gold crest is the brightest
point in the picture, and the whole scene still reads at 300 pixels across:
bright curl, glowing book, dark shelves, one small startled figure.

## How it is drawn

`main.ts` (Node 22, standard library only) is a small painterly renderer:

- The wave begins as a Catmull-Rom spine with a tapering radius — narrow
  where it bursts from the pages, swelling as it climbs, thinning as it
  curls into the break — baked into distance / spine-parameter / radius
  grids. Each pixel of the wave is then shaded in layers: a deep indigo body
  under a thinner lit teal shell, flow streaks running along the tube,
  ridged-noise gold filaments, specular glints, and foam — a surface band, a
  crest cap, the lining of the curl's throat, churn at the base — broken
  into ragged clumps by multi-scale fractal noise so it never resolves into
  a clean outline.
- The room is assembled from shaded shapes: a seeded bookshelf layout
  (varied muted spines, gilt bands, warm rim light on the edges that face
  the room), a wooden table holding a pool of book-light and the soft shadow
  the wave throws behind the book, a stack of closed books, and the open
  book itself as two glowing page quads with curl shading.
- The lighthouse, the leaping reader and the toppling chair are capsule/box
  SDF silhouettes, rim-lit from the SDF gradient toward the book's glow; the
  lighthouse beam is an analytic soft wedge with dust motes drifting in it.
- Crest spray, droplet streaks off the tip, the base splash, stars embedded
  in the wave body, ambient motes and a few big soft foreground droplets are
  additive splats, every one placed by a fixed-seed PRNG (mulberry32) —
  never `Math.random`, never the clock — so repeated runs produce
  byte-identical output.
- The frame is rendered at 2x supersampling and box-downsampled, passed
  through a filmic shoulder with seeded grain so the gradients never band,
  and written by a hand-rolled PNG encoder (CRC32, per-row best-filter
  selection, zlib deflate): a 1024x1024 RGB PNG of about 1.0 MB.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Writes `entry.png` into the output directory in a few seconds.
