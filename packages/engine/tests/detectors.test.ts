/**
 * Detector tests - hand-made candle fixtures with known answers, plus a no-lookahead check.
 * Run:  npm test
 *
 * If you edit a detector and the "no lookahead" test fails, you made it peek into the future.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../config';
import { atr, detectAll, dealingRange, findFvgs, findSwings, fvgsAsOf, trackStructure } from '../detectors';
import type { Candle } from '../types';

const H1 = 3_600_000;
const T0 = Date.UTC(2025, 0, 6);

/** Build candles from explicit highs/lows. Open/close default to the midpoint. */
function candles(highs: number[], lows: number[], closes?: number[], opens?: number[]): Candle[] {
  return highs.map((h, i) => {
    const mid = (h + lows[i]) / 2;
    return { time: T0 + i * H1, open: opens?.[i] ?? mid, high: h, low: lows[i], close: closes?.[i] ?? mid, volume: 0 };
  });
}
const cfg = (o: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...o });
const fvgCfg = (o: Partial<Config> = {}) => cfg({ fvgMinSize: 0.5, fvgMinAtrMult: 0, fvgMaxAgeBars: 50, ...o });
const runFvgs = (c: Candle[], k: Config) => findFvgs(c, H1, k, atr(c, k.atrPeriod));

// ------------------------------------------------------------------------------- fractals
describe('fractal swings', () => {
  it('finds highs/lows, confirms them N bars later, and lets the first of equal highs win', () => {
    const hi = [1, 2, 5, 2, 1, 2, 3, 3, 1];
    const c = candles(hi, hi.map((h) => h - 1));
    const s = findSwings(c, H1, cfg({ fractalN: 2 }));
    const got = s.map((x) => [x.kind, x.idx, x.confirmIdx]).sort();
    // equal highs at idx 6 and 7 -> only idx 6 is a swing
    expect(got).toEqual([['high', 2, 4], ['high', 6, 8], ['low', 4, 6]]);
    for (const x of s) expect(x.confirmTime).toBe(c[x.confirmIdx].time + H1);
  });

  it('needs N bars on both sides (edge bars are never swings)', () => {
    expect(findSwings(candles([5, 1, 1, 1, 1], [4, 0, 0, 0, 0]), H1, cfg({ fractalN: 2 }))).toEqual([]);
  });

  it('respects fractalN: a 1-bar wiggle is a swing for N=1 but not N=2', () => {
    const hi = [1, 3, 1, 1.5, 1.2];
    const c = candles(hi, hi.map((h) => h - 0.5));
    expect(findSwings(c, H1, cfg({ fractalN: 1 })).some((s) => s.kind === 'high' && s.idx === 1)).toBe(true);
    expect(findSwings(c, H1, cfg({ fractalN: 2 })).some((s) => s.kind === 'high' && s.idx === 1)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ FVG
describe('fair value gaps', () => {
  it('bullish gap: zone, formation bar and full lifecycle', () => {
    // candle0 high 10, candle2 low 12 -> bullish gap [10, 12]
    const c = candles([10, 15, 16, 14, 13, 12.5, 11], [8, 11, 12, 11.5, 9.5, 9, 8], [9, 14, 15, 13, 11, 10.5, 9.0]);
    const f = runFvgs(c, fvgCfg({ fvgEndOn: 'fill' }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ direction: 1, bottom: 10, top: 12, confirmIdx: 2, idxMid: 1 });
    expect(f[0].firstTouchIdx).toBe(3); // low 11.5 <= 12
    expect(f[0].fillIdx).toBe(4); //       low 9.5  <= 10
    expect(f[0].closeIdx).toBe(6); //      first close below 10 is bar 6
    expect([f[0].endIdx, f[0].endReason]).toEqual([4, 'fill']);
  });

  it('bearish gap, ending on a close beyond the far side', () => {
    // candle0 low 20, candle2 high 17 -> bearish gap [17, 20]
    const c = candles([22, 19, 17, 18, 21, 21, 22], [20, 14, 13, 15, 16, 17, 20], [21, 15, 14, 16, 19, 20.5, 21]);
    const f = runFvgs(c, fvgCfg({ fvgEndOn: 'close' }));
    expect(f[0]).toMatchObject({ direction: -1, bottom: 17, top: 20 });
    expect(f[0].firstTouchIdx).toBe(3); // high 18 >= 17
    expect(f[0].fillIdx).toBe(4); //       high 21 >= 20
    expect(f[0].closeIdx).toBe(5); //      close 20.5 > 20
    expect([f[0].endIdx, f[0].endReason]).toEqual([5, 'close']);
  });

  it('drops gaps below the size floor, and expires untouched ones', () => {
    // Only candles 0..2 form a gap; every later bar overlaps the high of the bar two before it.
    let hi = [10, 10.4, 10.9, 11, 11, 11, 11, 11];
    let lo = [8, 9, 10.3, 10.5, 10.6, 10.7, 10.8, 10.8]; // gap [10, 10.3] = 0.3 < 0.5 floor
    expect(runFvgs(candles(hi, lo), fvgCfg())).toEqual([]);

    hi = [10, 12.6, 12.5, 12.9, 12.9, 12.9, 12.9, 12.9]; // gap [10, 12], price never returns
    lo = [8, 9, 12, 12.4, 12.4, 12.4, 12.4, 12.4];
    const f = runFvgs(candles(hi, lo), fvgCfg({ fvgMaxAgeBars: 3 }));
    expect(f).toHaveLength(1);
    expect([f[0].endReason, f[0].endIdx]).toEqual(['expired', 2 + 3]);
  });

  it('ATR size filter: a gap smaller than fvgMinAtrMult * ATR is dropped', () => {
    const hi = [10, 15, 16, 14, 13, 12.5, 11, 10];
    const lo = [8, 11, 12, 11.5, 9.5, 9, 8, 7];
    const c = candles(hi, lo);
    const k = fvgCfg({ atrPeriod: 2 });
    expect(runFvgs(c, k)).toHaveLength(1); // gap size 2
    expect(runFvgs(c, { ...k, fvgMinAtrMult: 5 })).toHaveLength(0); // needs >= 5 x ATR (ATR ~ 5)
  });

  it('fvgsAsOf hides gaps that have not formed and events that have not happened yet', () => {
    const c = candles([10, 15, 16, 14, 13, 12.5, 11], [8, 11, 12, 11.5, 9.5, 9, 8]);
    const f = runFvgs(c, fvgCfg({ fvgEndOn: 'fill' }));
    expect(fvgsAsOf(f, 1)).toEqual([]); // not formed yet (confirmIdx 2)
    const at3 = fvgsAsOf(f, 3)[0];
    expect([at3.firstTouchIdx, at3.fillIdx, at3.endIdx, at3.endReason]).toEqual([3, -1, -1, 'open']);
    expect(fvgsAsOf(f, 4)[0].endReason).toBe('fill');
  });
});

// ------------------------------------------------------------------------------------ BOS
/** Swing high at idx 2 (price 10), confirmed at bar 4. Bar 5 wicks to 10.5 but CLOSES at 9.8;
 *  bar 6 closes at 10.4 (a real break). */
function bosFixture() {
  return candles(
    [8, 9, 10, 9, 8.5, 10.5, 10.6, 10.0],
    [6, 7, 8, 7.5, 7, 8, 9.8, 9.0],
    [7, 8, 9, 8, 8, 9.8, 10.4, 9.5],
    [6.5, 7, 8, 8.5, 8, 8.2, 9.9, 10.2],
  );
}
const runBos = (c: Candle[], k: Config) => trackStructure(c, H1, findSwings(c, H1, k), k);

describe('break of structure', () => {
  it('close mode ignores a wick poke and breaks on the first close beyond the level', () => {
    const st = runBos(bosFixture(), cfg({ fractalN: 2, bosUseClose: true }));
    expect(st.bos.map((b) => b.idx)).toEqual([6]);
    expect(st.bos[0]).toMatchObject({ direction: 1, level: 10, swingIdx: 2, kind: 'initial', confirmIdx: 6 });
    expect([st.trend[5], st.trend[6]]).toEqual([0, 1]);
  });

  it('wick mode breaks on the poke', () => {
    expect(runBos(bosFixture(), cfg({ fractalN: 2, bosUseClose: false })).bos.map((b) => b.idx)).toEqual([5]);
  });

  it('a level breaks only once, and a break against the trend is a reversal', () => {
    // up-break of the high at idx 2, then a swing low forms and is broken downward
    const c = candles(
      [8, 9, 10, 9, 8.5, 11, 11, 10, 9, 8, 7, 6.5, 6.4],
      [6, 7, 8, 7.5, 7, 9, 9.5, 8, 7, 6, 5, 4.5, 4.4],
      [7, 8, 9, 8, 8, 10.6, 10.5, 9, 8, 7, 6, 5, 4.6],
    );
    const bos = runBos(c, cfg({ fractalN: 2, bosUseClose: true })).bos;
    expect(bos[0]).toMatchObject({ direction: 1, kind: 'initial' });
    const down = bos.find((b) => b.direction === -1);
    expect(down?.kind).toBe('reversal');
    // each (direction, swingIdx) pair appears once
    const keys = bos.map((b) => `${b.direction}:${b.swingIdx}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// --------------------------------------------------------------- dealing range / zones
/** Seeded PRNG so the "random" series is the same every run. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function synthetic(n: number, seed: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let p = 3000;
  let regime = 1;
  for (let i = 0; i < n; i++) {
    if (r() < 1 / 40) regime = -regime;
    let ret = regime * 0.4 + (r() + r() + r() - 1.5) * 4;
    if (r() < 0.12) ret *= 3; // displacement candle -> produces FVGs
    const open = p;
    const close = p + ret;
    const high = Math.max(open, close) + r() * 1.5;
    const low = Math.min(open, close) - r() * 1.5;
    out.push({ time: T0 + i * H1, open, high, low, close, volume: 0 });
    p = close;
  }
  return out;
}

describe.each(['last_swing_pair', 'rolling', 'bos_leg'] as const)('dealing range: %s', (rule) => {
  it('keeps high > low, EQ at the midpoint and zone = sign(close - EQ)', () => {
    const c = synthetic(600, 11);
    const k = cfg({ dealingRangeRule: rule, dealingRangeLookback: 50 });
    const b = detectAll(c, H1, k).bars;
    let valid = 0;
    for (let t = 0; t < c.length; t++) {
      if (Number.isNaN(b.rangeHigh[t])) {
        expect(b.zone[t]).toBe(0);
        continue;
      }
      valid++;
      expect(b.rangeHigh[t]).toBeGreaterThan(b.rangeLow[t]);
      expect(b.eq[t]).toBeCloseTo((b.rangeHigh[t] + b.rangeLow[t]) / 2, 9);
      expect(b.zone[t]).toBe(Math.sign(c[t].close - b.eq[t]));
    }
    expect(valid).toBeGreaterThan(100);
  });

  it('rolling range equals the plain min/max of the last L bars', () => {
    if (rule !== 'rolling') return;
    const c = synthetic(200, 5);
    const k = cfg({ dealingRangeRule: 'rolling', dealingRangeLookback: 20 });
    const st = trackStructure(c, H1, findSwings(c, H1, k), k);
    const r = dealingRange(c, st, k);
    const slice = c.slice(100 - 19, 101);
    expect(r.rangeHigh[100]).toBe(Math.max(...slice.map((x) => x.high)));
    expect(r.rangeLow[100]).toBe(Math.min(...slice.map((x) => x.low)));
    expect(Number.isNaN(r.rangeHigh[18])).toBe(true); // window not full yet
  });
});

// ---------------------------------------------------------------------------- NO LOOKAHEAD
describe.each(['last_swing_pair', 'rolling', 'bos_leg'] as const)('no lookahead: %s', (rule) => {
  it.each([true, false])('recomputing on data cut at bar t matches the full run (bosUseClose=%s)', (useClose) => {
    const c = synthetic(900, 3);
    const k = cfg({ dealingRangeRule: rule, dealingRangeLookback: 50, bosUseClose: useClose, fvgMaxAgeBars: 40 });
    const full = detectAll(c, H1, k);
    // make sure the test is actually exercising something
    expect(full.swings.length).toBeGreaterThan(20);
    expect(full.fvgs.length).toBeGreaterThan(10);
    expect(full.bos.length).toBeGreaterThan(5);

    for (const t of [60, 137, 300, 555, 800]) {
      const part = detectAll(c.slice(0, t + 1), H1, k);
      expect(full.swings.filter((s) => s.confirmIdx <= t)).toEqual(part.swings);
      expect(full.bos.filter((b) => b.confirmIdx <= t)).toEqual(part.bos);
      expect(fvgsAsOf(full.fvgs, t)).toEqual(part.fvgs);
      for (const key of Object.keys(full.bars) as Array<keyof typeof full.bars>) {
        expect(Array.from(full.bars[key].slice(0, t + 1))).toEqual(Array.from(part.bars[key]));
      }
    }
  });
});
