/**
 * marketHours.ts - drop the candles Twelve Data publishes while spot gold is closed.
 *
 * WHY: from (at least) September 2026 Twelve Data fills every closed hour with a stale-quote candle: 96 candles
 * on each Saturday, the rest of Friday evening and Sunday before the open, and thin ones in the daily break, all
 * about $0.25 tall (the size of a spread). They are not market prices, but they sit between real candles, so the
 * detectors treat them as price action (ATR is pulled down, a weekend-open gap is hidden behind them, ...).
 * The Feb-Mar 2025 data has none of them, so this rule removes nothing there.
 *
 * THE SCHEDULE (checked against both data sets, in both winter and summer time):
 *   - gold closes at 17:00 New York time and reopens at 18:00 New York time
 *   - the weekly close runs from Friday 17:00 to Sunday 18:00 New York time
 *   In UTC that is 22:00/23:00 in winter and 21:00/22:00 in summer. The 2025 data's last Friday candle opens at
 *   21:45 UTC (winter) or 20:45 UTC (summer) and its first Sunday candle at 23:00 / 22:00 UTC, exactly this.
 *
 * Candle times are bar OPEN times in UTC, so a candle is closed-market when its OPEN time falls in a closed window.
 * New York time only matters for the daylight-saving switch (US rules: second Sunday of March to first Sunday of
 * November, both on a weekend inside the closed window, so the exact switch instant never decides a candle).
 *
 * This is applied when candles are READ, not when they are downloaded, so months already in the cache are cleaned
 * too and the cache keeps the raw data.
 */
import type { Candle } from '@engine/types';

export type Closure = 'weekend' | 'daily_break';

const HOUR = 3_600_000;
const CLOSE_MIN = 17 * 60; // 17:00 New York
const OPEN_MIN = 18 * 60; // 18:00 New York

/** Day of the month of the nth Sunday (1-based) in a UTC month. */
function nthSunday(year: number, month: number, nth: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0 = Sunday
  return 1 + ((7 - firstDow) % 7) + (nth - 1) * 7;
}

/** True while US daylight saving time is in force (EDT, UTC-4). */
function usDaylightTime(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7); // 02:00 EST on the 2nd Sunday of March
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); //  02:00 EDT on the 1st Sunday of November
  return ms >= start && ms < end;
}

/** Why a candle that opens at `ms` (UTC) falls in a closed market, or null when gold is trading. */
export function closureAt(ms: number): Closure | null {
  const local = new Date(ms + (usDaylightTime(ms) ? -4 : -5) * HOUR); // read with the getUTC* methods
  const dow = local.getUTCDay();
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (dow === 6) return 'weekend';
  if (dow === 5 && min >= CLOSE_MIN) return 'weekend';
  if (dow === 0 && min < OPEN_MIN) return 'weekend';
  if (min >= CLOSE_MIN && min < OPEN_MIN) return 'daily_break';
  return null;
}

/** The candles that opened while gold was trading, in order and untouched. */
export function dropClosedMarket(candles: Candle[]): Candle[] {
  return candles.filter((c) => closureAt(c.time) === null);
}
