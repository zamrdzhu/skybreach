# The Book That Contained the Sea

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A picture drawn entirely in code for make.fun's "Make the AI judge excited"
bounty (ai-excited-01) by @zamrdzhu01.

## The scene

A dark library at night. On a wooden table in the foreground an open book
glows with golden light — and out of its pages a towering ocean wave erupts,
deep indigo water crowned with foam and lit gold from within by the book
itself. On the book's left page stands a tiny lighthouse, impossibly real,
its beam sweeping across the room. A tiny reader leaps backward in shock
beside the table as a chair topples over, and loose pages flutter through
the spray. Warm gold against deep blue shadow; a diagonal composition with
the wave bursting toward the viewer. It reads at a glance from a thumbnail
and rewards a close look: foam lace on the crest, spray droplets, wood
grain on the table, bookshelf silhouettes fading into the dark.

## How it is drawn

`main.ts` (Node 22, standard library only) paints the image procedurally
with its own small rasterizer — soft-edged blobs, scanline polygons, thick
lines, radial glows and value-noise texture — layered in painter's order:
wall, bookshelves, table, the glowing book, the lighthouse, the wave
(a Catmull-Rom spine with layered water, a dark hollow inside the curl,
foam lace and spray), the fluttering pages, the reader and the chair, then
a vignette and a whisper of film grain. Its PNG encoder is written by hand
too (own CRC32 and per-row filter choice, zlib from the standard library).
Everything is driven by seeded randomness, so two runs produce a
byte-identical image.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/entry.png`: 1024×1024, under 1 MiB, in about three
seconds. Outside the grader, `MAKEFUN_OUTPUT_DIR` stands in for `/output`.
