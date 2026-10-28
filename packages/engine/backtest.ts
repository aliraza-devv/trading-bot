/**
 * backtest.ts - the event-driven loop. It walks the M15 candles one CLOSED candle at a time, carrying
 * the H1 context, and calls the rules in strategy.ts. It contains no trading rules of its own.
 *
 * ORDER OF EVENTS FOR EACH M15 CANDLE k  (everything decided here uses data up to the close of k-1,
 * except the candle's own high/low/open, which is what fills pending orders - see strategy.ts)
 *   0. gaps that became known by the close of candle k-1 join the waiting list
 *      (M15 gaps by M15 index, H1 gaps by the last H1 candle closed at that moment)
 *   1. gaps older than fvgMaxAgeBars expire
 *   2. an open position is advanced through candle k (stop / partial / breakeven / target)
 *   3. waiting gaps that candle k touched are consumed; each is evaluated (H1 first) and the first
 *      that qualifies opens a trade. No new trade on a candle in which a position was already open.
 *   4. at the close of k a trailing stop is updated (it applies from candle k+1)
 */
import type { Config } from './config';
import { detectAll } from './detectors';
import {
  closeAtMarket, evaluateSetup, manageBar, openPosition, sortByPriority, toTrade, trailCandidate,
  type Candidate, type Position,
} from './strategy';
import { TF_MS, type Candle, type SkipReason, type Structure, type Trade } from './types';

export interface BacktestResult {
  trades: Trade[];
  /** Realised equity after each closed trade (first point = start). `time` = close of the exit candle. */
  equity: Array<{ time: number; equity: number }>;
  /** How many touched gaps were rejected, by rule. */
  skipped: Record<SkipReason, number>;
  /** Gaps touched while waiting (= trades + skipped). */
  touched: number;
  startEquity: number;
  endEquity: number;
}

export const emptySkips = (): Record<SkipReason, number> => ({
  busy: 0, no_h1_context: 0, trend: 0, no_range: 0, zone: 0, no_erl: 0, erl_too_close: 0, session: 0, spread: 0, size: 0,
});

/**
 * For each M15 candle, the index of the last H1 candle that is CLOSED when that M15 candle closes
 * (-1 = none yet). Equal close times count as closed: the 10:00 M15 candle and the 09:00 H1 candle
 * finish together. H1 context for M15 candle k must only ever be read from this row.
 */
export function alignH1Index(m15: Candle[], h1: Candle[]): Int32Array {
  const out = new Int32Array(m15.length);
  let j = -1;
  for (let k = 0; k < m15.length; k++) {
    const closeK = m15[k].time + TF_MS.M15;
    while (j + 1 < h1.length && h1[j + 1].time + TF_MS.H1 <= closeK) j++;
    out[k] = j;
  }
  return out;
}

export function runBacktest(h1: Candle[], m15: Candle[], cfg: Config): BacktestResult {
  const skipped = emptySkips();
  if (m15.length === 0) {
    return { trades: [], equity: [], skipped, touched: 0, startEquity: cfg.startEquity, endEquity: cfg.startEquity };
  }

  const sH1: Structure = detectAll(h1, TF_MS.H1, cfg);
  const sM15: Structure = detectAll(m15, TF_MS.M15, cfg);
  const market = { h1: sH1, m15: sM15 };
  const h1Idx = alignH1Index(m15, h1);

  const useH1 = cfg.poiTimeframes !== 'm15';
  const useM15 = cfg.poiTimeframes !== 'h1';
  const maxAge = cfg.fvgMaxAgeBars;

  let waiting: Candidate[] = [];
  let nextH1 = 0; // pointers into the gap lists (ordered by confirmIdx)
  let nextM15 = 0;
  let pos: Position | null = null;
  let nextId = 1;
  let equity = cfg.startEquity;
  let touched = 0;
  const trades: Trade[] = [];
  const curve = [{ time: m15[0].time, equity }];

  const finish = (k: number) => {
    if (!pos) return;
    const t = toTrade(pos, k, cfg);
    trades.push(t);
    equity += t.pnl;
    curve.push({ time: m15[k].time + TF_MS.M15, equity });
    pos = null;
  };

  for (let k = 0; k < m15.length; k++) {
    const bar = m15[k];
    const prevH1 = k > 0 ? h1Idx[k - 1] : -1;

    // 0) gaps that were already known at the close of candle k-1 start waiting
    if (k > 0) {
      while (nextM15 < sM15.fvgs.length && sM15.fvgs[nextM15].confirmIdx <= k - 1) {
        if (useM15) waiting.push({ tf: 'M15', fvg: sM15.fvgs[nextM15] });
        nextM15++;
      }
      while (nextH1 < sH1.fvgs.length && sH1.fvgs[nextH1].confirmIdx <= prevH1) {
        if (useH1) waiting.push({ tf: 'H1', fvg: sH1.fvgs[nextH1] });
        nextH1++;
      }
    }

    // 1) expiry: a gap untouched for fvgMaxAgeBars bars of its own timeframe is dropped
    if (maxAge > 0 && waiting.length) {
      waiting = waiting.filter((c) => (c.tf === 'M15' ? k - 1 : prevH1) - c.fvg.confirmIdx < maxAge);
    }

    // 2) advance the open position through this candle
    const hadPosition = pos !== null;
    if (pos) {
      manageBar(pos, bar, false, cfg);
      if (pos.closed) finish(k);
    }

    // 3) touches -> entries (the first touch consumes a gap, trade or not)
    let tradedThisBar = false;
    if (waiting.length) {
      const hit: Candidate[] = [];
      const rest: Candidate[] = [];
      for (const c of waiting) {
        const touchedNow = c.fvg.direction === 1 ? bar.low <= c.fvg.top : bar.high >= c.fvg.bottom;
        (touchedNow ? hit : rest).push(c);
      }
      waiting = rest;
      for (const cand of sortByPriority(hit)) {
        touched++;
        const r = evaluateSetup(
          { cand, bar, k, h1IdxPrev: prevH1, market, equity, busy: hadPosition || tradedThisBar || pos !== null },
          cfg,
        );
        if (!r.ok) {
          skipped[r.reason]++;
          continue;
        }
        tradedThisBar = true;
        pos = openPosition(r.setup, bar, k, nextId++, cfg);
        manageBar(pos, bar, true, cfg); // entry candle: only the stop can act
        if (pos.closed) finish(k);
      }
    }

    // 4) trailing stop for the next candle
    if (pos && pos.trailing) {
      const swings = cfg.trailTimeframe === 'H1' ? sH1.swings : sM15.swings;
      const upTo = cfg.trailTimeframe === 'H1' ? h1Idx[k] : k;
      const next = trailCandidate(pos, swings, upTo, bar.close, cfg);
      if (next !== null) pos.stop = next;
    }
  }

  // End of data: close whatever is still open at the last close (flagged 'end_of_data').
  if (pos) {
    closeAtMarket(pos, m15[m15.length - 1], cfg);
    finish(m15.length - 1);
  }

  return { trades, equity: curve, skipped, touched, startEquity: cfg.startEquity, endEquity: equity };
}
