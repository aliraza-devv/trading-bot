import { describe, expect, it } from 'vitest';
import { aggregateToH1, dropUnclosed } from '../aggregate';
import { TF_MS, type Candle } from '../types';

const M = TF_MS.M15;
const T0 = Date.UTC(2025, 0, 6, 8); // 08:00 UTC
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time: T0 + i * M, open: o, high: h, low: l, close: c, volume: v });

describe('aggregateToH1', () => {
  it('builds correct OHLCV from four M15 bars', () => {
    const m15 = [bar(0, 10, 12, 9, 11, 1), bar(1, 11, 15, 10, 14, 2), bar(2, 14, 14, 8, 9, 3), bar(3, 9, 10, 8.5, 9.5, 4)];
    const h1 = aggregateToH1(m15, T0 + 10 * 3_600_000);
    expect(h1).toEqual([{ time: T0, open: 10, high: 15, low: 8, close: 9.5, volume: 10 }]);
  });

  it('keeps a short bucket in the middle of the data (session edge) but drops an unfinished last hour', () => {
    // 08:00 hour complete, 09:00 hour has only 2 bars then a gap, 11:00 hour has 1 bar (still forming)
    const m15 = [0, 1, 2, 3, 4, 5].map((i) => bar(i, 1, 2, 0, 1)).concat([bar(12, 1, 2, 0, 1)]);
    const asOf = T0 + 12 * M + M; // right after the 11:00 bar closed -> the 11:00 hour is NOT finished
    const h1 = aggregateToH1(m15, asOf);
    expect(h1.map((x) => (x.time - T0) / 3_600_000)).toEqual([0, 1]); // 08:00 and 09:00; 11:00 dropped
  });

  it('keeps an incomplete last hour once that hour has finished (market closed early)', () => {
    const m15 = [0, 1, 2].map((i) => bar(i, 1, 2, 0, 1)); // 3 bars, then the weekly close
    expect(aggregateToH1(m15, T0 + 2 * 3_600_000)).toHaveLength(1);
  });
});

describe('dropUnclosed', () => {
  it('removes bars whose close time is after asOf', () => {
    const m15 = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1), bar(2, 1, 1, 1, 1)];
    expect(dropUnclosed(m15, M, T0 + 2 * M)).toHaveLength(2); // bar 2 closes at T0 + 3M
    expect(dropUnclosed(m15, M, T0 + 3 * M)).toHaveLength(3); // closing exactly at asOf counts as closed
  });
});
