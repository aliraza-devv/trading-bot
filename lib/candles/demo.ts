/**
 * demo.ts - SYNTHETIC gold-like M15 candles for development and for checking the detectors when
 * the real feed is unavailable. It is a seeded regime-switching random walk, so the same date
 * always gives the same candles. These are NOT real prices - the UI labels them as such.
 */
import type { Candle } from '@engine/types';

const M15 = 15 * 60_000;
const ORIGIN = Date.UTC(2023, 0, 2); // a Monday; the series is generated from here so slices agree
export const DEMO_MAX_MS = Date.UTC(2028, 0, 1);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Demo candles with open time in [fromMs, toMs). Weekends are removed like the real market. */
export function demoM15(fromMs: number, toMs: number): Candle[] {
  const end = Math.min(toMs, DEMO_MAX_MS);
  const rnd = mulberry32(20240607);
  const normal = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

  const out: Candle[] = [];
  let price = 1850;
  let regime = 1;
  for (let t = ORIGIN; t < end; t += M15) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    const closed = dow === 6 || (dow === 0 && hour < 22) || (dow === 5 && hour >= 22);

    // Always advance the random stream, even on closed bars, so slices stay consistent.
    if (rnd() < 1 / 150) regime = -regime;
    const volMult = hour < 7 ? 0.6 : hour < 17 ? 1.3 : 0.8; // quiet Asia, active London/NY
    const sigma = 0.0009 * volMult;
    let shock = normal();
    if (rnd() < 0.08) shock *= 2.5; // fat tails -> displacement candles -> FVGs
    const wickUp = Math.abs(normal()) * 0.5;
    const wickDn = Math.abs(normal()) * 0.5;
    const vol = Math.floor(800 * volMult * (0.5 + rnd()));
    if (closed) continue;

    const open = price;
    const close = open * Math.exp(regime * 0.00012 + sigma * shock);
    const high = Math.max(open, close) + wickUp * sigma * open;
    const low = Math.min(open, close) - wickDn * sigma * open;
    price = close;
    if (t >= fromMs) out.push({ time: t, open, high, low, close, volume: vol });
  }
  return out;
}
