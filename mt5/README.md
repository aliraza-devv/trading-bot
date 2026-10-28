# MT5 demo bridge: setup guide

This connects the web app to **MetaTrader 5** so the strategy can place orders on a **demo (fake-money) account** on your own PC.
Nothing here costs money, needs a server, or touches a real account.

```
MT5 (your PC)  --candles, positions, orders-->  web app (your PC, localhost:3001)
IRL_Bridge EA  <--"place / renew / cancel / move stop"--  same rules as the backtest
```

The EA (`IRL_Bridge.mq5`) is the hands; the web app is the brain. The brain is the **same code the backtest uses**, so a setup
that qualifies live is one the backtest would have taken (a test replays 3,200 candles to prove it).

> **Status: not yet run against a real MT5.** The web side is tested (tests + a stand-in EA replaying real gold candles over HTTP).
> The EA file itself has never been compiled or run inside MetaTrader, because MT5 is not installed on the PC where it was written.
> Expect to possibly hit a compile error or a quirk of your broker on the first try. Run it with **DryRun = true** first (below),
> and send me the exact text of anything that fails.

## What you need

- A Windows PC that stays on while you want it to trade (sleep mode stops it).
- MetaTrader 5 with a **demo account** (free).
- This app running (`npm run bridge`).

## Step by step

### 1. Install MT5 and open a demo account
1. Download MetaTrader 5 from <https://www.metatrader5.com> (or from any broker that offers MT5) and install it.
2. In MT5: **File → Open an Account**, choose a broker server (the default **MetaQuotes-Demo** is fine), pick **Open a demo account**,
   leave the defaults, deposit e.g. 10,000, finish. The title bar should now show a demo account.
3. Find the gold symbol: **View → Market Watch** (Ctrl+M), right-click → **Symbols**, search `XAU` or `GOLD`. The name varies by broker
   (`XAUUSD`, `XAUUSDm`, `GOLD` ...). Tick it to show it. Remember the exact name.

### 2. Install the Expert Advisor
1. In MT5: **File → Open Data Folder**, open `MQL5` → `Experts`, and copy `IRL_Bridge.mq5` (from the `mt5` folder of this project) in.
2. Press **F4** to open MetaEditor, open `IRL_Bridge.mq5`, press **F7** (Compile). The bottom panel must say **0 errors**.
   Warnings are fine. If there are errors, copy the text and send it to me.

### 3. Allow the app's address
MT5 blocks web requests unless you allow them: **Tools → Options → Expert Advisors**, tick **Allow WebRequest for listed URL**,
add `http://localhost:3001`, OK.

### 4. Start the app
In a terminal in the `web` folder:

```bash
npm run bridge
```

The first start builds the app (about a minute), then it stays running; leave that window open. If something is already running on
port 3001 (the dev server), stop it first. Open <http://localhost:3001/live>: it says *Waiting for the Expert Advisor*.

(Tune the rules in the backtester first, then press **Use these rules for the MT5 bridge**. Without that it trades the built-in defaults.)

### 5. Attach the EA to the gold chart
1. Open the gold chart (**File → New Chart → your gold symbol**). Any timeframe works; M15 is clearest.
2. Press **Ctrl+N** (Navigator), **Expert Advisors → IRL_Bridge**, drag it onto the chart.
3. **Common** tab: tick **Allow Algo Trading**. **Inputs** tab: for the very first run set **DryRun = true**, then OK.
4. The toolbar button **Algo Trading** must be green.
5. In the top-right of the chart there should be a smiling face. The chart's top-left shows the EA's status text.

Within seconds the Live page should say **Connected**. In DryRun, MT5's **Experts** tab (bottom, Toolbox) logs lines like
`[dry run] would place sell limit 0.12 lots at ...`: those are the orders it *would* send.

### 6. Go live on the demo
When the DryRun lines look sensible, right-click the chart → **Expert Advisors → Properties → Inputs**, set **DryRun = false**.
From then on it places real **demo** orders.

## What you will see

- After every closed 15-minute candle (:00, :15, :30, :45) the EA syncs with the app. Gaps rarely qualify, so hours without
  an order are normal; the Live page's **Gaps being watched** table says why each gap was or wasn't taken.
- A qualifying setup becomes a **Buy Limit / Sell Limit** in MT5's Trade tab (comment `IRL:...`) with a stop loss and take profit.
  It expires after one candle and is renewed each candle while it stays valid.
- When it fills, the other resting orders are removed. At **+1R** the EA closes half and moves the stop to breakeven; from **+2R**
  the stop trails the latest swing; the rest closes at **+3R** (all adjustable in the backtester, then re-saved to the bridge).

## Safety, in plain words

| Protection | Where |
|---|---|
| Refuses to run on a real-money account | in the EA (and again in the app) |
| Every order has a stop loss at the broker | EA rejects any order without one |
| Risk per trade capped (`MaxRiskPct`, default 2%) and lots capped (`MaxLots`, default 1.0) | EA, whatever the app asks |
| Stops opening trades for the day after losing `MaxDailyLossPct` (default 3%) | EA, survives a restart |
| Resting orders expire after one candle; if the app is silent for 20 minutes the EA removes them | EA |
| Only touches orders/positions with its own magic number on its own symbol | EA |
| **Pause** button on the Live page | cancels resting orders at the next sync; open positions keep their stop and target |
| Only answers requests from this PC, never from a website | app |

If your PC sleeps or MT5 closes: open positions keep their **stop and final target** at the broker, but the partial, the breakeven
move and trailing do not happen while the EA is off.

## Settings (EA Inputs)

| Input | Default | Meaning |
|---|---|---|
| `ServerUrl` | `http://localhost:3001/api/bridge/decide` | the app. Must start with an address you allowed in step 3 |
| `DryRun` | false | true = log what it would do, send no orders |
| `MaxRiskPct` | 2.0 | hard cap on % of equity risked per trade |
| `MaxLots` | 1.0 | hard cap on lots per order |
| `MaxDailyLossPct` | 3.0 | stop for the day after this loss |
| `BarsToSend` | 3000 | closed M15 candles sent each time (about 6 weeks) |
| `MagicNumber` | 5051501 | tags this EA's orders. Change only if you run two copies |
| `DeviationPoints` | 50 | slippage allowed on the partial close |

## Stopping it

Press **Pause new trades** on the Live page, and/or right-click the chart → **Expert Advisors → Remove**. Delete any leftover
pending orders in the Trade tab (right-click → Delete).

## Where live results will differ from the backtest

A demo run is worth doing precisely because it shows these:

- **Real spread, slippage and fills.** The backtest assumes a spread of $0.30 and $0.10 slippage; the Live page shows your
  broker's actual spread and warns when it is well above the model.
- **Different candles.** The backtest used Twelve Data; live uses *your broker's* candles (the ones it fills against), so a few
  gaps will differ slightly.
- **Bid prices.** MT5 candles are bid prices. The app converts entry/stop/target levels for the spread (buys fill at the ask,
  shorts' stops trigger on the ask) so triggers behave like a touch of the chart.
- **Intrabar partial.** Live takes the partial at +1R on the tick; the backtest decides per candle. Breakeven is set at your real fill price.
- **Nearest gap first.** If two qualifying gaps in one direction wait, live rests an order at the nearest (price reaches it first); the
  backtest resolves a rare same-candle double touch by priority. Only one position at a time either way.
- **History window.** Structure (trend, ranges) is computed from the last `BarsToSend` candles; a backtest started months earlier
  can have a slightly different trend state at the beginning.
- **Broker time.** MT5 candle times are broker time; the EA converts them to UTC using the current offset. Around the broker's
  daylight-saving change an old candle's timestamp can be an hour off; it does not affect the rules.
- **Demo is not real.** Demo fills are friendlier than live ones, and a few weeks of results say little. This is a test bench,
  not a prediction, and not financial advice.

## Troubleshooting

| You see | Do this |
|---|---|
| Live page stays on *Waiting for the Expert Advisor* | Is `npm run bridge` still running? Is the EA on a chart (smiling face)? Is **Algo Trading** green? |
| Experts tab: `URL not allowed` / error 4060 | Step 3: add `http://localhost:3001` |
| Experts tab: `cannot reach the app` | The app isn't running, or something else is using port 3001 |
| `only N M15 candles available` | Scroll the M15 chart back a few weeks so MT5 downloads history; in **Tools → Options → Charts** raise *Max bars in chart* |
| The EA stops at once with an alert | You are on a real-money account. By design it will not run there |
| Orders rejected: invalid stops | Your broker's minimum stop distance is larger than the setup's; that setup is skipped |
| Symbol is not `XAUUSD` | Fine: attach the EA to whatever your gold chart is called |
| Live page says *Built-in defaults* | You never pressed **Use these rules for the MT5 bridge** in the backtester |

The app also keeps a journal of every decision in `web/live-data/decisions.jsonl` (git-ignored), for comparing demo results with the backtest later.
