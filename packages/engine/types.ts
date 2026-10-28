/**
 * types.ts - shared data shapes for the engine. Pure TypeScript: no UI / Next imports anywhere in
 * packages/engine, so the same code can run in the browser, a Web Worker, or Node tests.
 *
 * CONVENTIONS
 *  - All times are milliseconds since epoch, UTC.
 *  - `idx` is always the POSITION in the candle array the detector was run on.
 *  - Every detected item has `confirmIdx`: the bar at whose CLOSE it first becomes known. A strategy
 *    standing at the close of bar t may only use items with confirmIdx <= t (this is the whole
 *    no-lookahead contract - see detectors.ts).
 *  - Missing numeric values are NaN (never null/undefined) so the arrays stay typed.
 */

/** `time` is the bar's OPEN time. The bar is closed (and knowable) at time + timeframe length. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TF_MS = { M15: 15 * 60_000, H1: 60 * 60_000 } as const;
export type Timeframe = keyof typeof TF_MS;

/** +1 bullish / up, -1 bearish / down. */
export type Direction = 1 | -1;

export interface Swing {
  kind: 'high' | 'low';
  idx: number; // pivot bar
  price: number;
  time: number; // open time of the pivot bar
  confirmIdx: number; // idx + fractalN
  confirmTime: number; // close time of the confirming bar
}

export type FvgEnd = 'touch' | 'fill' | 'close' | 'expired' | 'open';

/**
 * Fair value gap. `bottom`..`top` is the gap. The first four "event" fields describe what happens
 * AFTER the gap forms (hindsight!): at bar t, never read them directly - use fvgsAsOf(fvgs, t).
 * -1 means "never happened (within max age)".
 */
export interface FVG {
  direction: Direction;
  bottom: number;
  top: number;
  size: number;
  ce: number; // consequent encroachment = midpoint of the gap
  idxFirst: number; // candle 1 of the 3-candle pattern
  idxMid: number; // candle 2 (drawing starts here)
  confirmIdx: number; // candle 3: gap is known at ITS close
  time: number; // open time of the middle candle
  confirmTime: number;
  firstTouchIdx: number; // wick enters the gap
  fillIdx: number; // wick trades through the whole gap
  closeIdx: number; // a bar CLOSES beyond the far side
  endIdx: number; // the event picked by cfg.fvgEndOn, or the expiry bar, else -1
  endReason: FvgEnd;
}

export type BosKind = 'initial' | 'continuation' | 'reversal';

export interface BOS {
  idx: number; // bar that closed (or wicked) through the level
  confirmIdx: number; // same as idx
  time: number;
  confirmTime: number;
  direction: Direction;
  level: number; // the broken swing's price
  swingIdx: number; // pivot of the broken swing
  swingTime: number;
  kind: BosKind;
}

/**
 * Per-bar state "as of the close of bar t" (column-oriented typed arrays; NaN = undefined).
 * Nothing in here looks past bar t.
 */
export interface BarStates {
  atr: Float64Array;
  trend: Int8Array; // +1 / -1 / 0 (no BOS yet)
  lastSH: Float64Array; // latest CONFIRMED swing high price
  lastSL: Float64Array;
  rangeHigh: Float64Array; // dealing range (see Config.dealingRangeRule)
  rangeLow: Float64Array;
  eq: Float64Array; // equilibrium = midpoint of the range
  pdPct: Float64Array; // 0 = range low, 0.5 = EQ, 1 = range high (may leave 0..1)
  zone: Int8Array; // +1 premium (close above EQ), -1 discount, 0 undefined
}

export interface Structure {
  swings: Swing[];
  fvgs: FVG[];
  bos: BOS[];
  bars: BarStates;
}

// ---------------------------------------------------------------------------------------------
// STAGE 2: strategy, trades, backtest
// ---------------------------------------------------------------------------------------------

/** Why a fill happened. 'stop' = initial stop, 'breakeven' = stop after the partial, 'trail' = trailed stop. */
export type FillReason = 'entry' | 'partial' | 'stop' | 'breakeven' | 'trail' | 'target' | 'end_of_data';

/**
 * One execution. `price` already includes spread + slippage. `time` is the OPEN time of the candle the
 * fill happened in (the order inside a candle is unknown). `pnl` is the gross result of an exit fill
 * (entry fills have 0); commission is kept separate.
 */
export interface Fill {
  time: number;
  price: number;
  lots: number;
  reason: FillReason;
  commission: number;
  pnl: number;
}

/** A tradable fair value gap (the IRL) together with the target it is expected to run to (the ERL). */
export interface POI {
  timeframe: Timeframe;
  direction: Direction;
  fvgConfirmIdx: number; // identifies the gap within its timeframe
  fvgTime: number; // open time of the gap's middle candle
  confirmTime: number; // when the gap became known
  bottom: number;
  top: number;
  erl: number; // external swing price on the same leg
  erlTime: number; // pivot time of that swing
}

/** Why a touched gap did not become a trade (counted in the results). */
export type SkipReason =
  | 'busy' //          a position was already open (or one was opened on this candle)
  | 'no_h1_context' // no H1 candle had closed yet
  | 'trend' //         H1 trend not in the trade's direction
  | 'no_range' //      H1 dealing range undefined
  | 'zone' //          gap not in discount (long) / premium (short) of the H1 range
  | 'no_erl' //        no confirmed external swing on the same leg yet
  | 'erl_too_close' // external swing nearer than minErlR x risk
  | 'session' //       touched outside the allowed session
  | 'spread' //        modelled spread above maxSpread
  | 'size'; //         risk distance or lot size not tradable

export interface Trade {
  id: number;
  direction: Direction;
  timeframe: Timeframe; // timeframe of the gap that was traded
  poi: POI;
  entryIdx: number; // M15 candle index of the entry
  exitIdx: number; // M15 candle index of the last exit
  entry: Fill;
  exits: Fill[];
  entryLevel: number; // limit price (candle/mid price scale), before costs
  stopLoss: number; // initial stop (mid scale)
  riskPerUnit: number; // |entryLevel - stopLoss| = 1R in price units
  lots: number;
  riskUsd: number; // riskPerUnit x contractSize x lots
  rMultiple: number; // NET result in R, after spread, slippage and commission
  pnl: number; // net USD
  commission: number; // total USD
  endedBy: FillReason; // reason of the last exit
  maxFavorableR: number; // furthest price went in the trade's favour (mid scale), for tuning
}
