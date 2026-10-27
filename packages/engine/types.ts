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
// STAGE 2 shapes - provisional, they will be finalised together with strategy.ts / backtest.ts.
// ---------------------------------------------------------------------------------------------

/** Point of interest: an FVG the strategy may trade from (IRL), with its target (ERL). */
export interface POI {
  timeframe: Timeframe;
  fvgIdx: number; // index into that timeframe's fvgs
  direction: Direction;
  erlPrice: number; // external range liquidity target (swing of the same leg)
}

export interface Fill {
  time: number;
  price: number; // after spread + slippage
  fraction: number; // share of the ORIGINAL position closed here (entry = 1)
  reason: string;
}

export interface Trade {
  id: number;
  direction: Direction;
  poi: POI;
  entry: Fill;
  exits: Fill[];
  stopLoss: number; // initial SL
  riskPerUnit: number; // |entry - SL|
  rMultiple: number; // net result in R, after all costs
  pnl: number;
}
