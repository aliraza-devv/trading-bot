# XAUUSD IRL → ERL backtester

A web app for backtesting and visualising an ICT-style "IRL to ERL" strategy on gold. Exploratory prototype:
transparency and easy rule-tweaking matter more than speed. Next.js (App Router) · React · TypeScript ·
Tailwind · Plotly.js. No Python.

## Status

| Stage | State | What it does |
|---|---|---|
| **1** | **built - awaiting review** | Candle data route + detectors. The page charts candles and marks **only** swings, FVGs, BOS and premium/discount, so you can check the detectors by eye. |
| 2 | not started | `strategy.ts`, `backtest.ts`, `metrics.ts`, the Web Worker, results page, trades table, CSV download. |

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # detector + data-layer unit tests
```

Pick a date range → **Load Dukascopy data** (or **Use demo data**) → switch H1/M15, step through the chart, and
change any setting on the left; the detectors recompute live.

### Data source - read this first

Dukascopy's candle feed is currently behind an AWS WAF **bot challenge** (HTTP 202 + `x-amzn-waf-action: challenge`).
`dukascopy-node` can get past it only by driving a headless Chrome, which is bot-check circumvention - so that
mode is deliberately **off** (`wafMode: 'off'` in `lib/candles/dukascopy.ts`) and it would not run on typical
serverless hosting anyway. While the challenge is in place the route returns a clear `source_blocked` error and
the UI offers the synthetic **demo data**, which is clearly labelled as fake. The Dukascopy path is built and
cached but could not be verified live; if the challenge goes away it should work unchanged. To use another
provider, add a month fetcher next to `fetchDukascopyMonth` (it is just `(startMs, endMs) => Candle[]`).

## Layout

```
packages/engine/          pure TypeScript - no UI, no Next imports
  types.ts                Candle, Swing, FVG, BOS, BarStates (+ provisional POI, Trade)
  config.ts               ONE typed Config with all defaults + CONFIG_FIELDS (the settings form is generated from it)
  detectors.ts            fractal swings, FVG, BOS, EQ + premium/discount
  aggregate.ts            M15 -> H1, drop bars that have not closed
  tests/                  hand-made candle fixtures + no-lookahead tests
lib/candles/              range.ts (per-month caching), dukascopy.ts, demo.ts
app/api/candles/route.ts  GET /api/candles?from=YYYY-MM-DD&to=YYYY-MM-DD&source=dukascopy|demo
components/, lib/buildFigure.ts   UI and the Plotly figure
```

Stage 2 adds `strategy.ts`, `backtest.ts`, `metrics.ts` to the engine and `workers/backtest.worker.ts`.

## Tuning the rules

| To change | Edit |
|---|---|
| any number or switch | `packages/engine/config.ts` (defaults + `CONFIG_FIELDS`; the form updates itself) |
| what counts as a swing | `findSwings` in `detectors.ts` |
| what counts as an FVG, or when it ends | `findFvgs` |
| BOS, trend, leg | `trackStructure` |
| EQ / premium-discount | `dealingRange` |
| colours, layers | `lib/buildFigure.ts` |

Dealing-range rules: `last_swing_pair` (latest confirmed swing low/high), `rolling` (lowest/highest of the last N
bars), `bos_leg` (the leg created by the latest BOS). With `last_swing_pair` the range goes stale after a break
until a new swing confirms; `bos_leg` keeps extending with the leg.

## No lookahead

Every swing / FVG / BOS has `confirmIdx`, the bar at whose **close** it first becomes known (a swing needs
`fractalN` bars to its right). `BarStates` holds only "state as of the close of bar t". The FVG event fields
(`firstTouchIdx`, `fillIdx`, `closeIdx`, `endIdx`) describe the future relative to the gap, so the backtest must read
FVGs through `fvgsAsOf(fvgs, t)`. The test suite recomputes every detector on data cut at bar *t* and requires it to
match the full run - run `npm test` after editing any detector. (Breaking a detector on purpose, e.g. confirming a
swing at its pivot bar, fails these tests.)

## Data route

`GET /api/candles` returns M15 candles plus H1 aggregated from them (so the two always agree) as
`[time, open, high, low, close, volume]` tuples, UTC, only **closed** bars. Ranges are capped at 400 days. Months
are cached in memory and in the OS temp dir (past months permanently, the current month for 10 minutes), so
overlapping ranges are downloaded once. On hosts with a read-only filesystem only the memory cache is used.
