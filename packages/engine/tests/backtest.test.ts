/**
 * Backtest tests: a hand-built scenario with a known outcome, rule switches, and the most important
 * check of all - NO LOOKAHEAD: re-running on data cut at candle c must reproduce exactly the trades
 * the full run had already finished by c.
 */
import { describe, expect, it } from 'vitest';
import { aggregateToH1 } from '../aggregate';
import { alignH1Index, runBacktest } from '../backtest';
import { DEFAULT_CONFIG, type Config } from '../config';
import { TF_MS, type Candle } from '../types';

const T0 = Date.UTC(2025, 0, 6, 10); // Monday 10:00 UTC, on an hour boundary
const M = TF_MS.M15;
const H = TF_MS.H1;

type Row = [o: number, h: number, l: number, c: number];
const m15 = (rows: Row[]): Candle[] => rows.map(([open, high, low, close], i) => ({ time: T0 + i * M, open, high, low, close, volume: 0 }));
const h1Of = (c: Candle[]) => aggregateToH1(c, Number.MAX_SAFE_INTEGER);

/** Simple, readable rules: no costs, 1 lot, only M15 gaps, no H1 filters. */
const base = (o: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  fractalN: 1, fvgMinSize: 0.5, fvgMinAtrMult: 0, fvgMaxAgeBars: 200,
  poiTimeframes: 'm15', requireTrendAlignment: false, requireZone: false, minErlR: 3,
  spread: 0, spreadWindows: [], slippage: 0, commissionPerLot: 0, slBuffer: 0, maxSpread: 0.6,
  sessionFilterEnabled: false, riskPct: 1.5, // -> exactly 1.00 lot for a 1.5 risk distance
  ...o,
});

/**
 * The scenario (fractalN = 1). Bar 3 completes a bullish gap [99.5, 101] (size 1.5); bar 4 is the peak
 * (a swing high at 110 that is confirmed at bar 5); price pulls back and touches the gap at bar 7, then
 * runs. By hand: entry 101, stop 99.5 (1R = 1.5), +1R = 102.5, +2R = 104, +3R = 105.5.
 *   bar 8 reaches +1R  -> half off (+0.5R), stop to 101
 *   bar 9 reaches +3R  -> rest off (+1.5R)           => +2.0R
 * Along the way: a second bullish gap [104,106] is touched at bar 5 before any swing is confirmed
 * ('no_erl'); a bearish gap [104,105] is touched at bar 9 while the long is still open ('busy').
 */
const SCENARIO: Row[] = [
  [99, 100, 98, 99],
  [99, 99.5, 96, 97],
  [97, 104, 97.5, 103],
  [103, 108, 101, 107],
  [107, 110, 106, 109],
  [109, 109, 105, 106],
  [106, 106, 103, 104],
  [104, 104, 100.5, 101],
  [101, 103, 101.5, 102.8],
  [102.8, 106, 102, 105.5],
  [105.5, 106, 104, 105],
  [105, 105.5, 104.5, 105],
];
const run = (rows: Row[], cfg: Config) => {
  const c = m15(rows);
  return runBacktest(h1Of(c), c, cfg);
};

describe('scenario with a known answer', () => {
  it('takes exactly one trade and makes +2.0R by hand-computed numbers', () => {
    const r = run(SCENARIO, base());
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t).toMatchObject({ direction: 1, timeframe: 'M15', entryIdx: 7, exitIdx: 9, endedBy: 'target', lots: 1 });
    expect([t.entryLevel, t.stopLoss, t.riskPerUnit, t.poi.erl]).toEqual([101, 99.5, 1.5, 110]);
    expect(t.exits.map((f) => [f.reason, f.price, f.lots])).toEqual([['partial', 102.5, 0.5], ['target', 105.5, 0.5]]);
    expect(t.rMultiple).toBeCloseTo(2, 9);
    expect(t.pnl).toBeCloseTo(300, 9);
    expect(r.endEquity).toBeCloseTo(10_300, 9);
  });

  it('counts why the other touched gaps were rejected', () => {
    const r = run(SCENARIO, base());
    expect(r.touched).toBe(3);
    expect(r.skipped).toMatchObject({ no_erl: 1, busy: 1 });
    expect(Object.values(r.skipped).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('applies spread, slippage and commission on every fill: +1.5533R by hand', () => {
    const r = run(SCENARIO, base({ spread: 0.4, slippage: 0.1, commissionPerLot: 3.5 }));
    const t = r.trades[0];
    // entry 101 + 0.2 + 0.1 = 101.3; partial 102.5 -> 102.2; target 105.5 -> 105.2
    expect(t.entry.price).toBeCloseTo(101.3);
    expect(t.exits.map((f) => f.price)).toEqual([expect.closeTo(102.2), expect.closeTo(105.2)]);
    // gross 0.5x0.9x100 + 0.5x3.9x100 = 240; commission 3.5 x (1 + 0.5 + 0.5) = 7; net 233 / 150
    expect(t.pnl).toBeCloseTo(233);
    expect(t.rMultiple).toBeCloseTo(233 / 150);
  });

  it('a pullback that hits the stop instead is a -1R loss', () => {
    const rows = SCENARIO.map((r) => [...r] as Row);
    rows[8] = [101, 101.2, 99.4, 99.8]; // low pierces the 99.5 stop
    const t = run(rows, base()).trades[0];
    expect([t.endedBy, t.exitIdx, t.rMultiple]).toEqual(['stop', 8, -1]);
  });

  it('data that ends while a trade is open closes it at the last close, flagged end_of_data', () => {
    const t = run(SCENARIO.slice(0, 8), base()).trades[0];
    expect([t.endedBy, t.exitIdx, t.exits[0].price]).toEqual(['end_of_data', 7, 101]);
  });
});

/** The scenario's long (the touch at bar 7). Blocking it leaves the later bearish gap free to be traded as a short. */
const longsOf = (r: ReturnType<typeof run>) => r.trades.filter((t) => t.direction === 1);

describe('rule switches', () => {
  it('minErlR: an external swing nearer than the requirement skips the trade', () => {
    const r = run(SCENARIO, base({ minErlR: 10 })); // ERL is 9 away = 6R
    expect(r.trades).toHaveLength(0);
    expect(r.skipped.erl_too_close).toBeGreaterThanOrEqual(1);
  });
  it('session filter: a touch outside the window is skipped', () => {
    const r = run(SCENARIO, base({ sessionFilterEnabled: true, sessionWindowsUtc: [['00:00', '01:00']] }));
    expect(r.trades).toHaveLength(0);
    expect(r.skipped.session).toBeGreaterThanOrEqual(1);
  });
  it('max spread: a modelled spread above the cap blocks entries', () => {
    const r = run(SCENARIO, base({ spread: 1.0, maxSpread: 0.6 }));
    expect(r.trades).toHaveLength(0);
    expect(r.skipped.spread).toBeGreaterThanOrEqual(1);
  });
  it('a wider-spread window (rollover) blocks entries only inside it', () => {
    const inside = run(SCENARIO, base({ spreadWindows: [['11:30', '12:00', 2.0]] })); // bar 7 opens 11:45
    expect(longsOf(inside)).toHaveLength(0);
    expect(inside.skipped.spread).toBe(1);
    const outside = run(SCENARIO, base({ spreadWindows: [['15:00', '16:00', 2.0]] }));
    expect(longsOf(outside)).toHaveLength(1);
    expect(outside.skipped.spread).toBe(0);
  });
  it('H1 trend / zone filters: this scenario has no H1 BOS, so both reject the setup', () => {
    expect(run(SCENARIO, base({ requireTrendAlignment: true })).skipped.trend).toBeGreaterThanOrEqual(1);
    expect(run(SCENARIO, base({ requireTrendAlignment: true })).trades).toHaveLength(0);
    expect(run(SCENARIO, base({ requireZone: true })).trades).toHaveLength(0);
  });
  it('poiTimeframes "h1" ignores M15 gaps entirely', () => {
    const r = run(SCENARIO, base({ poiTimeframes: 'h1' }));
    expect([r.trades.length, r.touched]).toEqual([0, 0]);
  });
  it('a gap too small to size (min lot) is skipped as "size"', () => {
    const r = run(SCENARIO, base({ riskPct: 0.0001 }));
    expect(r.trades).toHaveLength(0);
    expect(r.skipped.size).toBeGreaterThanOrEqual(1);
  });
  it('expiry: a gap older than fvgMaxAgeBars can no longer be traded', () => {
    expect(longsOf(run(SCENARIO, base({ fvgMaxAgeBars: 2 })))).toHaveLength(0); // touch at bar 7, gap formed at bar 3
    expect(longsOf(run(SCENARIO, base({ fvgMaxAgeBars: 4 })))).toHaveLength(1); // 7 <= 3 + 4
  });
});

describe('H1 alignment', () => {
  it('an M15 candle only ever sees H1 candles that have already closed', () => {
    const c = m15(SCENARIO);
    const h1 = h1Of(c);
    const idx = alignH1Index(c, h1);
    // 10:00 H1 candle closes at 11:00, i.e. with M15 bar 3 (10:45 open)
    expect(Array.from(idx.slice(0, 8))).toEqual([-1, -1, -1, 0, 0, 0, 0, 1]);
    for (let k = 0; k < c.length; k++) {
      if (idx[k] >= 0) expect(h1[idx[k]].time + H).toBeLessThanOrEqual(c[k].time + M);
      if (idx[k] + 1 < h1.length) expect(h1[idx[k] + 1].time + H).toBeGreaterThan(c[k].time + M);
    }
  });
});

// ------------------------------------------------------------------------- random-series checks
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomM15(n: number, seed: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let p = 3000;
  let regime = 1;
  for (let i = 0; i < n; i++) {
    if (r() < 1 / 60) regime = -regime;
    let ret = regime * 0.35 + (r() + r() + r() - 1.5) * 2.2;
    if (r() < 0.1) ret *= 3;
    const open = p;
    const close = p + ret;
    out.push({ time: T0 + i * M, open, high: Math.max(open, close) + r() * 0.8, low: Math.min(open, close) - r() * 0.8, close, volume: 0 });
    p = close;
  }
  return out;
}

/** Relaxed so a random series produces plenty of trades. */
const busy = (o: Partial<Config> = {}): Config => base({
  fractalN: 2, fvgMinSize: 0.4, fvgMinAtrMult: 0.1, minErlR: 1.5, riskPct: 1, spread: 0.3, slippage: 0.1, commissionPerLot: 3.5,
  poiTimeframes: 'both', ...o,
});

describe('random series', () => {
  const c15 = randomM15(3200, 42);
  const h1 = h1Of(c15);

  it('produces a healthy number of trades, each gap is traded at most once, and entries follow knowledge', () => {
    const r = runBacktest(h1, c15, busy());
    expect(r.trades.length).toBeGreaterThan(15);
    const keys = r.trades.map((t) => `${t.timeframe}:${t.poi.fvgConfirmIdx}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of r.trades) {
      expect(t.entry.time).toBeGreaterThanOrEqual(t.poi.confirmTime); // never entered before the gap was known
      expect(t.exitIdx).toBeGreaterThanOrEqual(t.entryIdx);
      expect(t.lots).toBeGreaterThan(0);
      expect(Number.isFinite(t.rMultiple)).toBe(true);
    }
    // one trade at a time: no overlap in time
    for (let i = 1; i < r.trades.length; i++) expect(r.trades[i].entryIdx).toBeGreaterThanOrEqual(r.trades[i - 1].exitIdx);
    // equity curve = start + running sum of net pnl
    const last = r.equity[r.equity.length - 1].equity;
    expect(last).toBeCloseTo(10_000 + r.trades.reduce((a, t) => a + t.pnl, 0), 6);
    expect(r.touched).toBe(r.trades.length + Object.values(r.skipped).reduce((a, b) => a + b, 0));
  });

  it('H1 gaps are taken ahead of M15 gaps when both are on', () => {
    const both = runBacktest(h1, c15, busy());
    expect(both.trades.some((t) => t.timeframe === 'H1')).toBe(true);
    expect(both.trades.some((t) => t.timeframe === 'M15')).toBe(true);
    expect(runBacktest(h1, c15, busy({ poiTimeframes: 'h1' })).trades.every((t) => t.timeframe === 'H1')).toBe(true);
  });

  it('is deterministic', () => {
    expect(runBacktest(h1, c15, busy())).toEqual(runBacktest(h1, c15, busy()));
  });

  describe.each(['M15', 'H1'] as const)('NO LOOKAHEAD (trail swings from %s)', (trailTimeframe) => {
    it('re-running on data cut at candle c reproduces every trade the full run had finished by c', () => {
      const cfg = busy({ trailTimeframe });
      const full = runBacktest(h1, c15, cfg);
      expect(full.trades.length).toBeGreaterThan(15);
      // Sparse cuts, plus cuts exactly at each early trade's entry candle, the candle before its exit and its
      // exit candle: that is where a rule peeking even a few candles ahead would change the outcome.
      const edges = full.trades.slice(0, 14).flatMap((t) => [t.entryIdx, t.exitIdx - 1, t.exitIdx]);
      const cuts = [...new Set([600, 1100, 1700, 2400, 3000, ...edges])].filter((c) => c > 50 && c < c15.length - 1);
      expect(cuts.length).toBeGreaterThan(30);
      for (const c of cuts) {
        const cutoffClose = c15[c].time + M;
        const part15 = c15.slice(0, c + 1);
        const partH1 = h1.filter((b) => b.time + H <= cutoffClose); // only H1 candles closed by then
        const part = runBacktest(partH1, part15, cfg);
        const finished = part.trades.filter((t) => t.endedBy !== 'end_of_data');
        const expected = full.trades.filter((t) => t.exitIdx <= c && t.endedBy !== 'end_of_data');
        expect(finished).toEqual(expected);
      }
    });
  });
});
