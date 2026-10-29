/**
 * Market-hours tests. The expected values come from the real data, not from the rule: the Feb-Mar 2025 Twelve Data
 * months have no candles while gold is closed, and their last Friday candle opens at 21:45 UTC in winter and 20:45 UTC
 * in summer (2025-03-07 and 2025-03-14 straddle the US clock change); the first Sunday candle opens at 23:00 / 22:00 UTC.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '@engine/types';
import { closureAt, dropClosedMarket } from './marketHours';

const M = 15 * 60_000;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const candle = (time: number): Candle => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 0 });

describe('closureAt: weekly close (Friday 17:00 - Sunday 18:00 New York)', () => {
  it('winter: last Friday candle 21:45 UTC trades, 22:00 is closed; Sunday 22:45 closed, 23:00 trades', () => {
    expect(closureAt(at(2025, 3, 7, 21, 45))).toBeNull();
    expect(closureAt(at(2025, 3, 7, 22, 0))).toBe('weekend');
    expect(closureAt(at(2025, 3, 2, 22, 45))).toBe('weekend');
    expect(closureAt(at(2025, 3, 2, 23, 0))).toBeNull();
  });

  it('summer: last Friday candle 20:45 UTC trades, 21:00 is closed; Sunday 21:45 closed, 22:00 trades', () => {
    expect(closureAt(at(2025, 3, 14, 20, 45))).toBeNull();
    expect(closureAt(at(2025, 3, 14, 21, 0))).toBe('weekend');
    expect(closureAt(at(2026, 10, 11, 21, 45))).toBe('weekend');
    expect(closureAt(at(2026, 10, 11, 22, 0))).toBeNull();
  });

  it('all of Saturday is closed, and Friday evening / Sunday morning', () => {
    for (const h of [0, 6, 12, 18, 23]) expect(closureAt(at(2026, 10, 10, h))).toBe('weekend');
    expect(closureAt(at(2026, 10, 9, 23, 45))).toBe('weekend');
    expect(closureAt(at(2026, 10, 11, 0, 0))).toBe('weekend');
    expect(closureAt(at(2026, 10, 11, 12, 0))).toBe('weekend');
  });

  it('follows the US clock change: Sunday 2025-03-09 (EDT from 07:00 UTC) opens at 22:00 UTC, 2025-11-02 (back to EST) at 23:00 UTC', () => {
    expect(closureAt(at(2025, 3, 9, 21, 45))).toBe('weekend');
    expect(closureAt(at(2025, 3, 9, 22, 0))).toBeNull();
    expect(closureAt(at(2025, 10, 26, 22, 0))).toBeNull(); // still summer time
    expect(closureAt(at(2025, 11, 2, 22, 45))).toBe('weekend');
    expect(closureAt(at(2025, 11, 2, 23, 0))).toBeNull();
    expect(closureAt(at(2025, 11, 7, 21, 45))).toBeNull(); // the Friday after: winter close is 22:00 UTC
    expect(closureAt(at(2025, 11, 7, 22, 0))).toBe('weekend');
  });

  it('uses the US dates, not the European ones: 2026-10-25 is still summer time in New York, the switch is 2026-11-01', () => {
    expect(closureAt(at(2026, 10, 25, 21, 45))).toBe('weekend');
    expect(closureAt(at(2026, 10, 25, 22, 0))).toBeNull();
    expect(closureAt(at(2026, 11, 1, 22, 45))).toBe('weekend');
    expect(closureAt(at(2026, 11, 1, 23, 0))).toBeNull();
  });
});

describe('closureAt: daily break (17:00 - 18:00 New York, Monday to Thursday)', () => {
  it('is 21:00-21:45 UTC in summer and 22:00-22:45 UTC in winter', () => {
    for (const mi of [0, 15, 30, 45]) {
      expect(closureAt(at(2026, 9, 3, 21, mi))).toBe('daily_break');
      expect(closureAt(at(2025, 2, 6, 22, mi))).toBe('daily_break');
    }
    expect(closureAt(at(2026, 9, 3, 20, 45))).toBeNull();
    expect(closureAt(at(2026, 9, 3, 22, 0))).toBeNull();
    expect(closureAt(at(2025, 2, 6, 21, 45))).toBeNull();
    expect(closureAt(at(2025, 2, 6, 23, 0))).toBeNull();
  });
});

describe('dropClosedMarket', () => {
  const week = (startMs: number) => {
    const out: Candle[] = [];
    for (let t = startMs; t < startMs + 7 * 86_400_000; t += M) out.push(candle(t));
    return out;
  };

  it('leaves 115 trading hours (460 candles) in any full week, winter, summer or across a clock change', () => {
    // Sunday-to-Saturday weeks: 2025-02-02 winter, 2025-03-09 starts summer time, 2026-09-06 summer, 2025-11-02 starts winter time
    for (const start of [at(2025, 2, 2, 0), at(2025, 3, 9, 0), at(2026, 9, 6, 0), at(2025, 11, 2, 0)]) {
      expect(dropClosedMarket(week(start))).toHaveLength(460);
    }
  });

  it('keeps the surviving candles unchanged and in order', () => {
    const input = week(at(2026, 9, 6, 0));
    const out = dropClosedMarket(input);
    expect(out.every((c) => input.includes(c))).toBe(true);
    expect(out.map((c) => c.time)).toEqual([...out.map((c) => c.time)].sort((a, b) => a - b));
    expect(out[0].time).toBe(at(2026, 9, 6, 22, 0)); // Sunday open, summer time
    expect(out[out.length - 1].time).toBe(at(2026, 9, 11, 20, 45)); // last Friday candle
  });

  it('keeps a quiet weekday candle however small it is (only the clock decides, not the candle shape)', () => {
    const tiny: Candle = { time: at(2026, 9, 3, 12, 0), open: 100, high: 100.1, low: 100, close: 100, volume: 0 };
    expect(dropClosedMarket([tiny])).toEqual([tiny]);
  });

  it('returns an empty list for an empty list', () => {
    expect(dropClosedMarket([])).toEqual([]);
  });
});
