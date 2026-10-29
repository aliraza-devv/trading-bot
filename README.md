# XAUUSD IRL → ERL backtester

A web app for backtesting and visualising an ICT-style "IRL to ERL" strategy on gold. Exploratory prototype:
transparency and easy rule-tweaking matter more than speed. Next.js (App Router) · React · TypeScript ·
Tailwind · Plotly.js. No Python.

## Status

| Stage | State | What it does |
|---|---|---|
| 1 | done | Candle data route + detectors (swings, FVGs, BOS, premium/discount) charted for visual checking. |
| 2 | built | Strategy, event-driven backtest, metrics, Web Worker, results page (chart with trades, equity curve, metrics, sortable trades table, CSV download). |
| 3 | **built - web side tested, EA not yet run in MT5** | MT5 **demo-account** bridge: live decision engine, Expert Advisor, live monitor page. See [`mt5/README.md`](mt5/README.md). |

## Run it

```bash
npm install
cp .env.example .env.local    # then put your Twelve Data key in it (see "Data source")
npm run dev                   # http://localhost:3000
npm test                      # 140 unit tests: detectors, strategy, backtest, metrics, data layer, live bridge
```

1. Pick a date range → **Load gold data** (or **Use demo data**, synthetic and clearly labelled).
2. Set the rules on the left. Everything is generated from the config; changing a detector setting redraws the chart live.
3. **Run backtest**. It runs in a Web Worker, so the page stays responsive. The chart gains entries, exits, stop and target
   lines; below it you get metrics, equity curve, R distribution, the reasons setups were skipped, and a trades table.
   Click a trade to zoom the chart to it. **Download trades CSV** exports every trade.

Changing a setting after a run marks the results "stale" until you run again.

## The strategy (all in `packages/engine/strategy.ts`)

A fair value gap (FVG) is the **IRL**: internal liquidity price tends to come back to. After it forms, price runs to an
external swing high/low, the **ERL**. We rest a limit order at the near edge of the gap and take the trade the first
time price returns to it. Longs buy bullish gaps, shorts sell bearish gaps.

A touched gap becomes a trade only if **all** of these hold (each failure is counted and shown on the results page):

1. no position is open (one trade at a time)
2. the touch candle is inside the session windows (if enabled)
3. the modelled spread at that time is ≤ `maxSpread`
4. **H1 context:** an H1 candle has closed; with `requireTrendAlignment` the H1 trend (last BOS) matches the direction;
   with `requireZone` the gap is in the H1 *discount* (longs) / *premium* (shorts)
5. **ERL exists:** a *confirmed* swing after the gap on the same leg: the highest swing high (long) / lowest swing low (short)
6. the ERL is at least `minErlR` × risk away
7. the risk distance sizes to at least `minLot`

H1 gaps are evaluated before M15 gaps (**H1 priority**), and each gap gets exactly **one** chance: the first touch consumes it
whether or not it became a trade.

**Entry / stop:** long = limit buy at the gap top, stop = gap bottom − `slBuffer` (shorts mirrored). 1R = |entry − stop|.

**Management:** at +`partialAtR` (1R) close `partialFraction` (50%) and move the stop to breakeven · from +`trailStartR` (2R)
the stop trails the latest confirmed swing low/high formed after entry (never loosens) · at +`finalTpR` (3R) close the rest.

### How fills are modelled (deliberately pessimistic)

- Candle prices are treated as **mid**. Touch / stop / target triggers use them; then **spread/2 + slippage is charged against
  you on every fill** (entry, partial, exit) plus commission per lot per fill. Spread follows a schedule: a normal value plus
  windows such as the daily rollover (default $1.00, 21:00-23:00 UTC), and entries are skipped while it exceeds `maxSpread`.
- Orders are placed at the **close** of a candle and can only fill in later candles; every decision uses data up to the
  previous close. A candle that gaps through a level fills at its open.
- On the **entry candle only the stop is checked**, and a target level the entry candle already traded through fills at the
  level, never at a better later open.
- If one candle could hit both the stop and a target, **the stop is assumed to hit first**. After a partial, the candle's
  adverse extreme is assumed to come after it (so breakeven can be hit in the same candle).
- Trailing-stop updates use swings confirmed by the candle's close and apply from the **next** candle.
- Position size = `riskPct` of current (realised) equity ÷ risk distance, rounded **down** to `lotStep`.
- Wins are capped near +1.9R by design (half off at 1R, half at 3R, minus costs). Tight stops make costs loom large: with a
  $1-2 stop, spread + slippage alone can cost 0.4R round trip.

## Data source

Real candles come from **[Twelve Data](https://twelvedata.com/docs)** (15-minute XAU/USD, UTC).

1. Get a free API key at <https://twelvedata.com/pricing> (instant, no card).
2. `cp .env.example .env.local`, put the key in `TWELVEDATA_API_KEY=`, and restart `npm run dev`.
   On a host (Vercel etc.) set the same variable in the project's environment settings. The key is only ever read
   on the server and is sent to Twelve Data in a header, never in a URL, so it cannot show up in logs or responses.

Verified against the live service: the response and error formats, that a **free key returns XAU/USD 15-minute candles**,
and that **timestamps are candle opens** (the daily break lines up with New York 17:00-18:00 and shifts by an hour when US
daylight saving starts). If a different key/plan ever lacks gold the UI says so ("The data plan does not include this
data"). If you switch providers, re-check the timestamp meaning and set `TWELVEDATA_BAR_TIME=close` if candles are close-stamped:
getting it wrong shifts every candle by one period, which is silent lookahead.

**Closed-market candles are removed.** Recent Twelve Data months (checked: Sep-Oct 2026) contain filler candles while
gold is closed: 96 on every Saturday, the rest of Friday evening and Sunday before the open, and thin ones in the daily
break, all about $0.25 tall (a spread, not a price move). The Feb-Mar 2025 data has none. `lib/candles/marketHours.ts`
drops every candle that opens between 17:00 and 18:00 New York time, or between Friday 17:00 and Sunday 18:00 (the
schedule both data sets follow), each time candles are read; the cache keeps the raw data. The number removed comes back
from `/api/candles` as `removedClosedMarket`. Your own broker's hours can differ (the MetaQuotes demo also has no gold
candles from 20:00 to 22:00 UTC), so live results on a broker's candles will not match candle for candle.

**Limits.** The free plan allows 8 requests/minute and 800/day. One month of M15 data is one request, requests are
spaced automatically (`TWELVEDATA_CREDITS_PER_MIN`), and a single load is capped at `TWELVEDATA_MAX_DAYS` (default 180
days, about 45 s the first time). Downloaded months are cached (memory + OS temp dir; on serverless hosting only for the
life of the instance). Candles carry **no volume and no spread**, so spread is a model in the config, not data.

Dukascopy (`?source=dukascopy`) is still in the code but is blocked by a bot challenge that this app deliberately does not
bypass. To add another provider (e.g. OANDA's v20 API, which would also supply bid/ask): write a
`(startMs, endMs) => Promise<Candle[]>` month fetcher that throws `ProviderError` on failure and register it in
`lib/candles/providers.ts`.

## Layout

```
packages/engine/          pure TypeScript - no UI, no Next imports
  types.ts                Candle, Swing, FVG, BOS, POI, Fill, Trade ...
  config.ts               ONE typed Config with all defaults + CONFIG_FIELDS (the settings form is generated from it)
  detectors.ts            fractal swings, FVG, BOS, EQ + premium/discount
  strategy.ts             ALL trading rules: setup filters, entry/stop, sizing, trade management, costs
  backtest.ts             event-driven loop over M15 closes carrying H1 context (no rules of its own)
  live.ts / bridge.ts     the same rules asked "what now?" for the MT5 bridge, and its wire format
  metrics.ts              win rate, expectancy, profit factor, drawdown, R distribution
  aggregate.ts            M15 -> H1, drop bars that have not closed
  tests/                  hand-made candle fixtures, rule tests, no-lookahead tests
workers/backtest.worker.ts  runs the engine off the main thread
lib/candles/              providers.ts, twelvedata.ts, dukascopy.ts, demo.ts, range.ts (per-month caching), store.ts, errors.ts
lib/                      buildFigure.ts (Plotly figures), useBacktest.ts (worker hook), tradesCsv.ts
app/api/candles/route.ts  GET /api/candles?from=YYYY-MM-DD&to=YYYY-MM-DD&source=twelvedata|dukascopy|demo
components/               Explorer (page), ConfigForm, ResultsPanel, PlotlyChart, LivePanel (/live)
app/api/bridge/           decide (EA talks here), status, control (pause), config (rules in force)
lib/bridge/               store.ts (saved rules, pause, journal), guard.ts (localhost only)
mt5/                      IRL_Bridge.mq5 (Expert Advisor) and its setup guide
```

## MT5 demo bridge (stage 3)

Optional: lets the same rules place orders on a **MetaTrader 5 demo account** on your own PC. Free, no server. Follow
[`mt5/README.md`](mt5/README.md) (install MT5, compile `mt5/IRL_Bridge.mq5`, allow `http://localhost:3001`), then:

```bash
npm run bridge      # builds and serves on http://localhost:3001; the monitor is at /live
```

- `packages/engine/live.ts` answers "what should happen now?" from the closed candles plus the broker's state. It calls the **same** rule
  functions as the backtest (no rules of its own) and keeps no state: a gap is "waiting" because no candle has touched it yet.
  `packages/engine/bridge.ts` is the plain-text wire format (MQL5 has no JSON parser).
- Tests replay a 3,200-candle series candle by candle and check both ways: every backtest trade was an order the live engine would have
  rested (same entry, stop, risk), and every order it rests that price then touches IS a backtest trade; plus the trailing stop, stale
  data, non-demo, pause, reconciliation and bid/ask conversion. Deliberately breaking `live.ts` seven ways fails the suite each time.
- The EA is hard-locked to demo accounts and enforces its own caps (risk, lots, daily loss, stop loss on every order). Orders expire
  after one candle, so a stopped bridge leaves nothing behind. The bridge routes answer only requests addressed to localhost and refuse
  browser cross-site requests. Pause and the rules in force are on the `/live` page; saved rules and the decision journal live in the
  git-ignored `live-data/` folder.

## Tuning the rules

| To change | Edit |
|---|---|
| any number or switch | `packages/engine/config.ts` (defaults + `CONFIG_FIELDS`; the form updates itself) |
| which gaps qualify, entry, stop, sizing, management, costs | `strategy.ts` |
| what counts as a swing / FVG / BOS / EQ | `detectors.ts` |
| what is reported | `metrics.ts`, `components/ResultsPanel.tsx` |
| colours, chart layers | `lib/buildFigure.ts` |

Dealing-range rules: `last_swing_pair` (latest confirmed swing low/high), `rolling` (lowest/highest of the last N bars),
`bos_leg` (the leg created by the latest BOS).

## No lookahead

Every swing / FVG / BOS has `confirmIdx`, the bar at whose **close** it first becomes known (a swing needs `fractalN` bars
to its right). The backtest never reads an FVG's hindsight fields; it keeps its own state from closed candles, and H1 context
for an M15 candle comes only from H1 candles that have already **closed** (`alignH1Index`). The tests enforce this:
detectors and the whole backtest are re-run on data cut at many points (including exactly at each trade's entry and exit) and
must reproduce what the full run had already done. Deliberately breaking the rules - using unconfirmed swings, peeking ahead
for the trailing stop, including the still-forming H1 candle, letting the entry candle take targets, checking targets before
stops - fails the suite.

## Reading results honestly

- A backtest on past data does not predict the future. Few trades (the page warns below 30) mean win rate and expectancy are
  mostly noise; aim for 100+ across trending and choppy periods.
- Tuning many settings on the same dates overfits. Keep settings few and check dates you did not tune on.
- Results depend on the cost model (spread, slippage, commission) and on candles that are not your broker's feed.
- The same input always gives the same output.
