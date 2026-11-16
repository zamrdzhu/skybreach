# skybreach

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/zamrdzhu/skybreach/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

**SKYBREACH** — a single image, drawn entirely in code by one Node program. No
image assets, no libraries: every pixel is computed.

## The image

A colossal whale breaches out of a sea of clouds at night, leaping on a rising
diagonal through an enormous ring of molten gold light, frozen at the peak of
the breach. Spray and shed droplets hang in the air around it. Far below the
whale's belly, on a crest of the cloud deck, a tiny human figure stands with
one arm raised, holding a small lantern — the scale contrast is the story: the
leviathan fills the sky, the person is a speck, and both are lit by the same
ring. Deep indigo and teal darkness against molten gold; the whole composition
drives up the diagonal toward the breach point, and it still reads at 300
pixels across: bright ring, dark whale, pale cloud deck, one tiny figure.

## How it is drawn

`main.ts` (Node 22, standard library only) is a small SDF renderer:

- The whale is a chain of circles swept along a Catmull-Rom spine, each sample
  shifted toward the belly so the back flattens and the belly rounds; tail
  flukes and a pectoral fin are smooth-min blended capsules. It is shaded as a
  near-black silhouette with a gold rim light computed from the SDF gradient
  and the direction to the ring.
- The ring is an analytic annulus — halo, band and white-hot core — with its
  brightness modulated around the arc, over a gradient sky with hash-grid
  stars, god rays and a vignette.
- The cloud sea is a smooth-min union of billow circles precomputed into an
  SDF grid; coverage comes from the SDF, but shading keys off the analytic
  surface line so the deck sinks into fog with mist strata below instead of
  stacking into layers. A brighter burst of puffs sits in front of the whale
  where it breaks through.
- Spray, drifting motes, speed streaks, droplets shedding off the whale's
  belly and the lantern's glow are additive splats, all placed by a fixed-seed
  PRNG (mulberry32) — never `Math.random` or the clock — so two runs produce
  byte-identical output.
- The scene is rendered at 2x supersampling and box-downsampled, given a soft
  filmic shoulder and seeded grain so the gradients never band, then written
  by a hand-rolled PNG encoder (CRC32, per-row best-filter selection, zlib
  deflate) as a 1024x1024 RGB PNG of about 900 KB.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Writes `entry.png` into the output directory in a few seconds.
