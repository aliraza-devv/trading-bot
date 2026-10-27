/**
 * detectors.ts - market-structure detectors: fractal swings, FVGs, BOS, EQ + premium/discount.
 *
 * Works on ANY timeframe's candle array. Plain loops on purpose: every rule reads top to bottom,
 * so tweaking one is a small local edit.
 *
 * NO-LOOKAHEAD CONTRACT
 *   Every item carries `confirmIdx` = the bar at whose CLOSE it first becomes known:
 *     swing : pivot idx + fractalN        (it needs N bars to its right)
 *     FVG   : idx of the 3rd candle
 *     BOS   : idx of the candle that closed through the level
 *   `BarStates` holds only "state as of the close of bar t".
 *   The FVG event fields (firstTouchIdx, fillIdx, closeIdx, endIdx) are HINDSIGHT - they describe
 *   what happens after the gap formed. In a backtest at bar t, read FVGs through
 *   fvgsAsOf(fvgs, t), which hides everything that happens after t.
 */
import type { Config } from './config';
import type { BarStates, BOS, BosKind, Candle, Direction, FVG, FvgEnd, Structure, Swing } from './types';

// ------------------------------------------------------------------------------------- ATR
/** Simple moving average of True Range. Value at t uses bars <= t only; NaN until `period` bars. */
export function atr(c: Candle[], period: number): Float64Array {
  const n = c.length;
  const out = new Float64Array(n).fill(NaN);
  const tr = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const hl = c[i].high - c[i].low;
    tr[i] = i === 0 ? hl : Math.max(hl, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// --------------------------------------------------------------------------------- swings
/**
 * Fractal swings. Bar i is a swing HIGH if its high is strictly greater than every high of the N
 * bars before it AND >= every high of the N bars after it (so the FIRST of two equal highs wins).
 * Swing LOW is the mirror image. Raw fractals: no high/low alternation is enforced.
 * Output is ordered by pivot idx (highs before lows on the same bar), which is also confirmIdx order.
 */
export function findSwings(c: Candle[], tfMs: number, cfg: Config): Swing[] {
  const N = cfg.fractalN;
  const out: Swing[] = [];
  for (let i = N; i < c.length - N; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= N; k++) {
      if (c[i - k].high >= c[i].high) isHigh = false; // left side: strict
      if (c[i + k].high > c[i].high) isHigh = false; //  right side: non-strict (equal highs allowed)
      if (c[i - k].low <= c[i].low) isLow = false;
      if (c[i + k].low < c[i].low) isLow = false;
    }
    const confirmIdx = i + N;
    const confirmTime = c[confirmIdx].time + tfMs; // close of the confirming bar
    if (isHigh) out.push({ kind: 'high', idx: i, price: c[i].high, time: c[i].time, confirmIdx, confirmTime });
    if (isLow) out.push({ kind: 'low', idx: i, price: c[i].low, time: c[i].time, confirmIdx, confirmTime });
  }
  return out;
}

// ------------------------------------------------------------------------------------ FVG
/**
 * 3-candle fair value gap on candles (i-2, i-1, i):
 *   bullish: low[i]  > high[i-2]  -> gap [high[i-2], low[i]]
 *   bearish: high[i] < low[i-2]   -> gap [high[i], low[i-2]]
 * Kept only if size >= max(fvgMinSize, fvgMinAtrMult * ATR[i]) (no ATR yet -> absolute floor only).
 *
 * Lifecycle events - the first bar AFTER formation where each happens (-1 = never within max age):
 *   firstTouchIdx : a wick enters the gap
 *   fillIdx       : a wick trades through the whole gap
 *   closeIdx      : a bar CLOSES beyond the far side of the gap
 * endIdx/endReason: the event chosen by cfg.fvgEndOn; else "expired" at confirmIdx + fvgMaxAgeBars;
 * else "open" (still live at the end of the data).
 */
export function findFvgs(c: Candle[], tfMs: number, cfg: Config, atrArr: Float64Array): FVG[] {
  const n = c.length;
  const out: FVG[] = [];
  const maxAge = cfg.fvgMaxAgeBars;

  for (let i = 2; i < n; i++) {
    let direction: Direction;
    let bottom: number;
    let top: number;
    if (c[i].low > c[i - 2].high) {
      direction = 1;
      bottom = c[i - 2].high;
      top = c[i].low;
    } else if (c[i].high < c[i - 2].low) {
      direction = -1;
      bottom = c[i].high;
      top = c[i - 2].low;
    } else {
      continue;
    }

    const size = top - bottom;
    const atrFloor = Number.isNaN(atrArr[i]) ? 0 : cfg.fvgMinAtrMult * atrArr[i];
    if (size < Math.max(cfg.fvgMinSize, atrFloor)) continue;

    // Scan the bars after formation for the three events (stop early once all are found).
    const j1 = maxAge === 0 ? n : Math.min(n, i + 1 + maxAge);
    let touch = -1;
    let fill = -1;
    let close = -1;
    for (let j = i + 1; j < j1 && close === -1; j++) {
      if (direction === 1) {
        if (touch === -1 && c[j].low <= top) touch = j;
        if (fill === -1 && c[j].low <= bottom) fill = j;
        if (c[j].close < bottom) close = j;
      } else {
        if (touch === -1 && c[j].high >= bottom) touch = j;
        if (fill === -1 && c[j].high >= top) fill = j;
        if (c[j].close > top) close = j;
      }
    }

    let endIdx = cfg.fvgEndOn === 'touch' ? touch : cfg.fvgEndOn === 'fill' ? fill : close;
    let endReason: FvgEnd = cfg.fvgEndOn;
    if (endIdx === -1) {
      if (maxAge > 0 && i + maxAge < n) {
        endIdx = i + maxAge;
        endReason = 'expired';
      } else {
        endReason = 'open';
      }
    }

    out.push({
      direction, bottom, top, size, ce: (top + bottom) / 2,
      idxFirst: i - 2, idxMid: i - 1, confirmIdx: i,
      time: c[i - 1].time, confirmTime: c[i].time + tfMs,
      firstTouchIdx: touch, fillIdx: fill, closeIdx: close, endIdx, endReason,
    });
  }
  return out;
}

/**
 * The FVG list exactly as an observer at the close of bar t would see it: only gaps confirmed by
 * t, with every event that happens after t hidden (-1 / "open"). Use this in the backtest.
 */
export function fvgsAsOf(fvgs: FVG[], t: number): FVG[] {
  const hide = (idx: number) => (idx > t ? -1 : idx);
  return fvgs
    .filter((f) => f.confirmIdx <= t)
    .map((f) => {
      const endIdx = hide(f.endIdx);
      return {
        ...f,
        firstTouchIdx: hide(f.firstTouchIdx),
        fillIdx: hide(f.fillIdx),
        closeIdx: hide(f.closeIdx),
        endIdx,
        endReason: endIdx === -1 ? 'open' : f.endReason,
      };
    });
}

// ------------------------------------------------------------- BOS + trend + leg tracking
interface StructureState {
  bos: BOS[];
  trend: Int8Array;
  lastSH: Float64Array;
  lastSL: Float64Array;
  legHigh: Float64Array;
  legLow: Float64Array;
}

/**
 * One pass over the bars. Returns the BOS list plus per-bar trend / latest swings / current leg.
 *
 * Active levels = the most recent CONFIRMED swing high and swing low. A level can be broken once;
 * a newer confirmed swing of the same type replaces it.
 *   BOS up   : close (or wick, if bosUseClose=false) above the active swing high
 *   BOS down : mirror image. If both fire on one bar, the candle's colour decides.
 *   kind     : "initial" (no trend yet) / "continuation" (same way as the trend) / "reversal"
 *
 * Also tracks the current "leg" for dealingRangeRule = "bos_leg":
 *   after a BOS the leg's ORIGIN extreme is the lowest low (bullish) / highest high (bearish) from
 *   the broken swing's pivot to the BOS bar; the OTHER end then keeps extending with price.
 */
export function trackStructure(c: Candle[], tfMs: number, swings: Swing[], cfg: Config): StructureState {
  const n = c.length;
  const bos: BOS[] = [];
  const trend = new Int8Array(n);
  const lastSH = new Float64Array(n).fill(NaN);
  const lastSL = new Float64Array(n).fill(NaN);
  const legHigh = new Float64Array(n).fill(NaN);
  const legLow = new Float64Array(n).fill(NaN);

  let shP = NaN, shI = -1, shLive = false; // active swing high
  let slP = NaN, slI = -1, slLive = false; // active swing low
  let curTrend: -1 | 0 | 1 = 0;
  let legDir = 0;
  let lHigh = NaN, lLow = NaN;
  let sp = 0; // pointer into `swings` (ordered by confirmIdx)

  for (let t = 0; t < n; t++) {
    // 1) swings that become known at the close of bar t
    while (sp < swings.length && swings[sp].confirmIdx <= t) {
      const s = swings[sp++];
      if (s.kind === 'high') { shP = s.price; shI = s.idx; shLive = true; }
      else { slP = s.price; slI = s.idx; slLive = true; }
    }

    // 2) did bar t break an active level?
    let up = shLive && (cfg.bosUseClose ? c[t].close : c[t].high) > shP;
    let dn = slLive && (cfg.bosUseClose ? c[t].close : c[t].low) < slP;
    if (up && dn) {
      if (c[t].close >= c[t].open) dn = false; else up = false; // both: candle colour decides
    }

    if (up || dn) {
      const direction: Direction = up ? 1 : -1;
      const level = up ? shP : slP;
      const swingIdx = up ? shI : slI;
      const kind: BosKind = curTrend === 0 ? 'initial' : curTrend === direction ? 'continuation' : 'reversal';
      bos.push({
        idx: t, confirmIdx: t, time: c[t].time, confirmTime: c[t].time + tfMs,
        direction, level, swingIdx, swingTime: c[swingIdx].time, kind,
      });
      if (up) shLive = false; else slLive = false;
      curTrend = direction;
      legDir = direction;
      // Same span for both directions: origin extreme fixed here, the other end keeps extending.
      lLow = Infinity; lHigh = -Infinity;
      for (let k = swingIdx; k <= t; k++) {
        if (c[k].low < lLow) lLow = c[k].low;
        if (c[k].high > lHigh) lHigh = c[k].high;
      }
    } else if (legDir === 1) {
      if (c[t].high > lHigh) lHigh = c[t].high; // bullish leg: only the high extends
    } else if (legDir === -1) {
      if (c[t].low < lLow) lLow = c[t].low; //  bearish leg: only the low extends
    }

    trend[t] = curTrend;
    lastSH[t] = shP;
    lastSL[t] = slP;
    legHigh[t] = lHigh;
    legLow[t] = lLow;
  }
  return { bos, trend, lastSH, lastSL, legHigh, legLow };
}

// ----------------------------------------------------------- EQ + premium / discount
/**
 * Dealing range -> rangeHigh/rangeLow, eq (midpoint), pdPct (0 = low, 0.5 = EQ, 1 = high; may leave
 * 0..1 once price runs past a stale range) and zone (+1 premium: close above EQ, -1 discount,
 * 0 undefined). A range with high <= low is treated as undefined. All values are "as of close of t".
 */
export function dealingRange(c: Candle[], st: StructureState, cfg: Config) {
  const n = c.length;
  const rangeHigh = new Float64Array(n);
  const rangeLow = new Float64Array(n);
  const eq = new Float64Array(n);
  const pdPct = new Float64Array(n);
  const zone = new Int8Array(n);

  for (let t = 0; t < n; t++) {
    let hi: number;
    let lo: number;
    if (cfg.dealingRangeRule === 'last_swing_pair') {
      hi = st.lastSH[t]; lo = st.lastSL[t];
    } else if (cfg.dealingRangeRule === 'rolling') {
      const L = cfg.dealingRangeLookback;
      if (t + 1 < L) { hi = NaN; lo = NaN; }
      else {
        hi = -Infinity; lo = Infinity;
        for (let k = t - L + 1; k <= t; k++) {
          if (c[k].high > hi) hi = c[k].high;
          if (c[k].low < lo) lo = c[k].low;
        }
      }
    } else { // bos_leg
      hi = st.legHigh[t]; lo = st.legLow[t];
    }

    if (hi > lo) { // false for NaN, so undefined ranges fall through
      const mid = (hi + lo) / 2;
      rangeHigh[t] = hi; rangeLow[t] = lo; eq[t] = mid;
      pdPct[t] = (c[t].close - lo) / (hi - lo);
      zone[t] = c[t].close > mid ? 1 : c[t].close < mid ? -1 : 0;
    } else {
      rangeHigh[t] = NaN; rangeLow[t] = NaN; eq[t] = NaN; pdPct[t] = NaN; zone[t] = 0;
    }
  }
  return { rangeHigh, rangeLow, eq, pdPct, zone };
}

// ------------------------------------------------------------------------------- one call
/** Run every detector on one timeframe's candles. `tfMs` is that timeframe's bar length. */
export function detectAll(c: Candle[], tfMs: number, cfg: Config): Structure {
  const atrArr = atr(c, cfg.atrPeriod);
  const swings = findSwings(c, tfMs, cfg);
  const fvgs = findFvgs(c, tfMs, cfg, atrArr);
  const st = trackStructure(c, tfMs, swings, cfg);
  const range = dealingRange(c, st, cfg);
  const bars: BarStates = {
    atr: atrArr, trend: st.trend, lastSH: st.lastSH, lastSL: st.lastSL, ...range,
  };
  return { swings, fvgs, bos: st.bos, bars };
}
