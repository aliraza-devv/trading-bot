/**
 * aggregate.ts - turn M15 candles into H1 candles, and drop candles that are not closed yet.
 * Pure functions (no I/O), shared by the data route and tests.
 *
 * Why aggregate H1 from M15 instead of downloading H1 separately: one download, and the two
 * timeframes are guaranteed to agree bar-for-bar (no off-by-one-hour surprises between feeds).
 */
import { TF_MS, type Candle } from './types';

/** Remove candles that have not CLOSED by `asOfMs` (e.g. the bar still forming right now). */
export function dropUnclosed(c: Candle[], tfMs: number, asOfMs: number): Candle[] {
  return c.filter((x) => x.time + tfMs <= asOfMs);
}

/**
 * Aggregate M15 -> H1. `m15` must be sorted by time with no duplicates.
 *  - Bucket = clock hour (open time floored to the hour).
 *  - A bucket with fewer than 4 bars that is followed by later data is kept: that is a real
 *    session edge (weekly close / reopen, holiday), not a cut in the data.
 *  - The LAST bucket is dropped if it is incomplete AND its hour has not finished by `asOfMs`
 *    (the data was cut mid-hour, or the hour is still forming). Keeping it would hand the strategy
 *    an H1 bar whose high/low/close are not final.
 */
export function aggregateToH1(m15: Candle[], asOfMs: number): Candle[] {
  const H = TF_MS.H1;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let count = 0;

  const flush = (isLast: boolean) => {
    if (!cur) return;
    const complete = count === H / TF_MS.M15;
    if (complete || !isLast || cur.time + H <= asOfMs) out.push(cur);
    cur = null;
    count = 0;
  };

  for (const x of m15) {
    const bucket = Math.floor(x.time / H) * H;
    if (cur && cur.time !== bucket) flush(false);
    if (!cur) {
      cur = { time: bucket, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume };
      count = 1;
    } else {
      if (x.high > cur.high) cur.high = x.high;
      if (x.low < cur.low) cur.low = x.low;
      cur.close = x.close;
      cur.volume += x.volume;
      count++;
    }
  }
  flush(true);
  return out;
}
