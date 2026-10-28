/**
 * Live-engine tests. The point of live.ts is that it takes EXACTLY the setups the backtest takes, so the
 * main tests replay a long random series candle by candle and compare the two:
 *   - every trade the backtest took was an order the live engine would have had resting, with the same numbers
 *   - every order the live engine rests that price then touches IS a backtest trade on that candle
 *   - the live trailing stop, fed candle by candle, reproduces the backtest's final stop
 * The rest covers the safety behaviour: stale data, bad data, non-demo, pause, an open position, reconciling
 * with orders already at the broker, and the bid/ask price conversion.
 */
import { describe, expect, it } from 'vitest';
import { aggregateToH1 } from '../aggregate';
import { runBacktest } from '../backtest';
import { detectAll } from '../detectors';
import { trailCandidate } from '../strategy';
import { DEFAULT_CONFIG, type Config } from '../config';
import { checkBars, commentForKey, decideLive, gapKey, keyFromComment, type LiveAction, type LiveDecision, type LiveState } from '../live';
import { TF_MS, type Candle } from '../types';

const T0 = Date.UTC(2025, 0, 6, 10);
const M = TF_MS.M15;

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

/** Relaxed rules so a random series produces plenty of trades, with the modelled spread equal to the live one. */
const busy = (o: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  fractalN: 2, fvgMinSize: 0.4, fvgMinAtrMult: 0.1, fvgMaxAgeBars: 200,
  poiTimeframes: 'both', requireTrendAlignment: false, requireZone: false, minErlR: 1.5,
  spread: 0.3, spreadWindows: [], slippage: 0.1, commissionPerLot: 3.5, slBuffer: 0, maxSpread: 0.6,
  sessionFilterEnabled: false, riskPct: 1,
  ...o,
});

const state = (nowMs: number, equity: number, o: Partial<LiveState> = {}): LiveState => ({
  nowMs, equity, spreadNow: 0.3, tickSize: 0.01, demo: true, paused: false, positions: [], orders: [], ...o,
});
type Place = Extract<LiveAction, { type: 'place' }>;
const places = (d: LiveDecision) => d.actions.filter((a): a is Place => a.type === 'place');
const at = (c15: Candle[], c: number) => c15.slice(0, c + 1); // candles closed after candle index c
const closeOf = (c15: Candle[], c: number) => c15[c].time + M;
const MIN = { minBars: 50 };

const c15 = randomM15(3200, 42);
const cfg = busy();
const full = runBacktest(aggregateToH1(c15, Number.MAX_SAFE_INTEGER), c15, cfg);
const trades = full.trades;
const equityBefore = (k: number) => cfg.startEquity + trades.filter((t) => t.exitIdx < k).reduce((a, t) => a + t.pnl, 0);
const positionOpenDuring = (k: number) => trades.some((t) => t.entryIdx < k && t.exitIdx >= k);
/** Trades with enough candles before them for the live engine to be asked about (it wants a warm-up). */
const warm = trades.filter((t) => t.entryIdx > 80);

describe('parity with the backtest (random series, 3200 candles)', () => {
  it('the series is rich enough to mean something', () => {
    expect(trades.length).toBeGreaterThan(30);
    expect(warm.length).toBeGreaterThan(30);
    expect(trades.some((t) => t.direction === 1) && trades.some((t) => t.direction === -1)).toBe(true);
    expect(trades.some((t) => t.timeframe === 'H1') && trades.some((t) => t.timeframe === 'M15')).toBe(true);
  });

  it('every backtest trade was a setup the live engine qualified one candle earlier, with the same numbers', () => {
    let resting = 0;
    for (const t of warm.slice(0, 40)) {
      const c = t.entryIdx - 1;
      const d = decideLive(at(c15, c), state(closeOf(c15, c), equityBefore(t.entryIdx)), cfg, MIN);
      expect(d.status, `trade ${t.id}`).toBe('ok');
      const key = gapKey(t.timeframe, { time: t.poi.fvgTime });
      const row = d.waiting.find((w) => w.key === key);
      expect(row, `trade ${t.id} gap ${key} should be waiting`).toBeDefined();
      expect(['order', 'nearer_first'], `trade ${t.id}`).toContain(row!.verdict);
      if (row!.verdict === 'order') {
        resting++;
        const p = places(d).find((a) => a.key === key)!;
        expect([p.direction, p.level, p.stop]).toEqual([t.direction, t.entryLevel, t.stopLoss]);
        expect(p.risk).toBeCloseTo(t.riskPerUnit, 9);
        expect(p.erl).toBe(t.poi.erl);
      }
    }
    expect(resting).toBeGreaterThan(20); // most are the nearest gap; a few sit behind a nearer one touched on the same candle
  });

  it('every order the live engine rests that price then touches is a trade the backtest took on that candle', () => {
    let touched = 0;
    let rested = 0;
    for (let c = 300; c < c15.length - 2; c += 7) {
      if (positionOpenDuring(c + 1)) continue; // the backtest was busy; live would hold a position, tested separately
      const d = decideLive(at(c15, c), state(closeOf(c15, c), equityBefore(c + 1)), cfg, MIN);
      for (const p of places(d)) {
        rested++;
        const next = c15[c + 1];
        if (p.direction === 1 ? next.low <= p.level : next.high >= p.level) {
          touched++;
          expect(trades.some((t) => t.entryIdx === c + 1 && t.direction === p.direction), `candle ${c + 1} touched ${p.key}`).toBe(true);
        }
      }
    }
    expect(rested).toBeGreaterThan(40);
    expect(touched).toBeGreaterThan(8);
  });

  it('a decision depends only on closed candles: extra, still-forming candles change nothing', () => {
    const c = warm[3].entryIdx - 1;
    const base = decideLive(at(c15, c), state(closeOf(c15, c), 10_000), cfg, MIN);
    const withFuture = decideLive(c15.slice(0, c + 4), state(closeOf(c15, c), 10_000), cfg, MIN); // 3 candles that have not closed yet
    expect(withFuture).toEqual(base);
  });
});

describe('parity with short-lived gaps (fvgMaxAgeBars = 8): the expiry boundary is exercised', () => {
  const cfgS = busy({ fvgMaxAgeBars: 8 });
  const runS = runBacktest(aggregateToH1(c15, Number.MAX_SAFE_INTEGER), c15, cfgS);
  const tradesS = runS.trades;
  const eqS = (k: number) => cfgS.startEquity + tradesS.filter((t) => t.exitIdx < k).reduce((a, t) => a + t.pnl, 0);
  const busyS = (k: number) => tradesS.some((t) => t.entryIdx < k && t.exitIdx >= k);

  it('qualification matches both ways: every trade was resting, every touched resting order was a trade', () => {
    expect(tradesS.length).toBeGreaterThan(20);
    for (const t of tradesS.filter((x) => x.entryIdx > 80).slice(0, 40)) {
      const c = t.entryIdx - 1;
      const d = decideLive(at(c15, c), state(closeOf(c15, c), eqS(t.entryIdx)), cfgS, MIN);
      const row = d.waiting.find((w) => w.key === gapKey(t.timeframe, { time: t.poi.fvgTime }));
      expect(row, `trade ${t.id} should be waiting`).toBeDefined();
      expect(['order', 'nearer_first']).toContain(row!.verdict);
    }
    let touched = 0;
    for (let c = 300; c < c15.length - 2; c += 3) {
      if (busyS(c + 1)) continue;
      const d = decideLive(at(c15, c), state(closeOf(c15, c), eqS(c + 1)), cfgS, MIN);
      for (const p of places(d)) {
        const next = c15[c + 1];
        if (p.direction === 1 ? next.low <= p.level : next.high >= p.level) {
          touched++;
          expect(tradesS.some((t) => t.entryIdx === c + 1 && t.direction === p.direction), `candle ${c + 1} touched ${p.key}`).toBe(true);
        }
      }
    }
    expect(touched).toBeGreaterThan(8);
  });
});

describe('bid/ask price conversion', () => {
  const find = (dirn: 1 | -1) => {
    for (const t of warm) {
      const c = t.entryIdx - 1;
      const d = decideLive(at(c15, c), state(closeOf(c15, c), equityBefore(t.entryIdx), { spreadNow: 0.4 }), cfg, MIN);
      const p = places(d).find((a) => a.key === gapKey(t.timeframe, { time: t.poi.fvgTime }));
      if (p && p.direction === dirn) return p;
    }
    throw new Error('no setup found');
  };

  it('a long buys at the ask: limit = gap top + spread; stop and target trigger on the bid', () => {
    const p = find(1);
    expect(p.price).toBeCloseTo(p.level + 0.4, 2);
    expect(p.sl).toBeCloseTo(p.stop, 2);
    expect(p.tp).toBeCloseTo(p.level + cfg.finalTpR * p.risk, 2);
    expect(p.sl).toBeLessThan(p.price);
    expect(p.price).toBeLessThan(p.tp);
  });

  it('a short sells at the bid: limit = gap bottom; its stop and target trigger on the ask (+ spread)', () => {
    const p = find(-1);
    expect(p.price).toBeCloseTo(p.level, 2);
    expect(p.sl).toBeCloseTo(p.stop + 0.4, 2);
    expect(p.tp).toBeCloseTo(p.level - cfg.finalTpR * p.risk + 0.4, 2);
    expect(p.tp).toBeLessThan(p.price);
    expect(p.price).toBeLessThan(p.sl);
  });

  it('orders live only through the next candle (plus a short grace), so a dead bridge cannot leave stale orders', () => {
    const c = warm[0].entryIdx - 1;
    const p = places(decideLive(at(c15, c), state(closeOf(c15, c), 10_000), cfg, MIN))[0];
    expect(p.expiresMs).toBe(closeOf(c15, c) + M + 120_000);
    expect(p.comment).toBe(commentForKey(p.key));
  });
});

/** A moment at which the live engine rests an order, plus everything needed to replay it. */
const sample = (() => {
  for (const t of warm) {
    const c = t.entryIdx - 1;
    const d = decideLive(at(c15, c), state(closeOf(c15, c), equityBefore(t.entryIdx)), cfg, MIN);
    if (places(d).length) return { c, d, t };
  }
  throw new Error('no sample');
})();
const sampleState = (o: Partial<LiveState> = {}) => state(closeOf(c15, sample.c), equityBefore(sample.t.entryIdx), o);
const sampleBars = at(c15, sample.c);

describe('safety: when NOT to act', () => {
  const first = places(sample.d)[0];
  const resting = { ticket: 501, direction: first.direction, volume: 0.1, price: first.price + 5, sl: first.sl, tp: first.tp, key: first.key };
  const cancels = (d: LiveDecision) => d.actions.filter((a) => a.type === 'cancel').map((a) => (a as { ticket: number }).ticket).sort();

  it('stale data (market closed / feed stuck): no orders, and anything resting is cancelled', () => {
    const d = decideLive(sampleBars, sampleState({ nowMs: closeOf(c15, sample.c) + 11 * 60_000, orders: [resting] }), cfg, MIN);
    expect(d.status).toBe('stale');
    expect(places(d)).toHaveLength(0);
    expect(cancels(d)).toEqual([501]);
  });

  it('a non-demo account: nothing is placed and resting orders are cancelled', () => {
    const d = decideLive(sampleBars, sampleState({ demo: false, orders: [resting] }), cfg, MIN);
    expect(d.status).toBe('not_demo');
    expect(places(d)).toHaveLength(0);
    expect(cancels(d)).toEqual([501]);
  });

  it('paused: nothing new is placed, resting orders are cancelled, and qualifying gaps are shown as paused', () => {
    const d = decideLive(sampleBars, sampleState({ paused: true, orders: [resting] }), cfg, MIN);
    expect(d.status).toBe('paused');
    expect(places(d)).toHaveLength(0);
    expect(cancels(d)).toEqual([501]);
    expect(d.waiting.some((w) => w.verdict === 'paused')).toBe(true);
  });

  it('too little history: structure is not trustworthy, so no orders', () => {
    const d = decideLive(sampleBars.slice(-200), sampleState(), cfg); // default minBars = 600
    expect(d.status).toBe('short_history');
    expect(places(d)).toHaveLength(0);
  });

  it('broken candles are rejected, never traded on', () => {
    const broken = sampleBars.map((b) => ({ ...b }));
    broken[20].high = broken[20].low - 1;
    expect(decideLive(broken, sampleState(), cfg, MIN).status).toBe('bad_data');
    const shifted = sampleBars.map((b) => ({ ...b, time: b.time + 60_000 })); // not on a 15-minute boundary
    expect(decideLive(shifted, sampleState(), cfg, MIN).status).toBe('bad_data');
    expect(checkBars([sampleBars[5], sampleBars[5]])).toMatch(/increasing/);
  });

  it('a real spread above maxSpread blocks new orders (the backtest only has a modelled one)', () => {
    const d = decideLive(sampleBars, sampleState({ spreadNow: 0.9 }), cfg, MIN);
    expect(places(d)).toHaveLength(0);
    expect(d.waiting.some((w) => w.reason === 'spread')).toBe(true);
  });

  it('an open position: no new orders, resting orders are cancelled', () => {
    const pos = { ticket: 9, direction: first.direction, volume: 0.1, openPrice: first.level, sl: first.sl, tp: first.tp, openTime: closeOf(c15, sample.c) - 60_000, key: first.key };
    const d = decideLive(sampleBars, sampleState({ positions: [pos], orders: [resting] }), cfg, MIN);
    expect(places(d)).toHaveLength(0);
    expect(cancels(d)).toEqual([501]);
    expect(d.actions.find((a) => a.type === 'cancel')).toMatchObject({ reason: 'a position is open' });
  });
});

describe('reconciling with orders already at the broker', () => {
  const first = places(sample.d)[0];

  it('an order that is still right is renewed (new expiry), not duplicated', () => {
    const existing = { ticket: 7, direction: first.direction, volume: 0.1, price: first.price, sl: first.sl, tp: first.tp, key: first.key };
    const d = decideLive(sampleBars, sampleState({ orders: [existing] }), cfg, MIN);
    expect(d.actions.filter((a) => a.type === 'renew')).toHaveLength(1);
    expect(d.actions.find((a) => a.type === 'renew')).toMatchObject({ ticket: 7, key: first.key, expiresMs: first.expiresMs });
    expect(places(d).find((p) => p.key === first.key)).toBeUndefined();
  });

  it('an order for a gap that no longer qualifies, or without a tag, is cancelled; duplicates are cancelled too', () => {
    const base = { direction: first.direction, volume: 0.1, price: first.price, sl: first.sl, tp: first.tp };
    const d = decideLive(
      sampleBars,
      sampleState({ orders: [{ ...base, ticket: 1, key: first.key }, { ...base, ticket: 2, key: first.key }, { ...base, ticket: 3, key: 'M1' }, { ...base, ticket: 4, key: '' }] }),
      cfg, MIN,
    );
    expect(d.actions.filter((a) => a.type === 'renew').map((a) => (a as { ticket: number }).ticket)).toEqual([1]);
    expect(d.actions.filter((a) => a.type === 'cancel').map((a) => (a as { ticket: number }).ticket).sort()).toEqual([2, 3, 4]);
  });
});

describe('comment tags', () => {
  it('survive a round trip and ignore unrelated comments', () => {
    expect(keyFromComment(commentForKey('H28980000'))).toBe('H28980000');
    expect(keyFromComment('[sl] manual')).toBe('');
    expect(keyFromComment('')).toBe('');
  });
});

describe('open positions', () => {
  it('the plan names the partial level (1R from the gap edge) and the breakeven stop', () => {
    const t = sample.t;
    const key = gapKey(t.timeframe, { time: t.poi.fvgTime });
    const c = t.entryIdx; // the entry candle has just closed
    const open = c15[t.entryIdx].time + 60_000;
    const pos = { ticket: 11, direction: t.direction, volume: 0.2, openPrice: 123.45, sl: t.stopLoss, tp: 0, openTime: open, key };
    const d = decideLive(at(c15, c), state(closeOf(c15, c), 10_000, { positions: [pos] }), cfg, MIN);
    expect(d.plans).toHaveLength(1);
    expect(d.plans[0]).toMatchObject({ ticket: 11, key, partialFraction: cfg.partialFraction, breakeven: 123.45 });
    expect(d.plans[0].partialPrice).toBeCloseTo(t.entryLevel + t.direction * cfg.partialAtR * t.riskPerUnit, 9);
  });

  it('a position whose gap is unknown is left to the broker stop, with a note', () => {
    const pos = { ticket: 12, direction: 1 as const, volume: 0.2, openPrice: 3000, sl: 2990, tp: 0, openTime: closeOf(c15, 700) - 1000, key: 'M1' };
    const d = decideLive(at(c15, 700), state(closeOf(c15, 700), 10_000, { positions: [pos] }), cfg, MIN);
    expect(d.plans).toHaveLength(0);
    expect(d.actions).toHaveLength(0);
    expect(d.notes.join(' ')).toMatch(/not in the data window/);
  });
});

describe('trailing stop: fed candle by candle, live reproduces the backtest', () => {
  // Costs off, so the stop can be read straight off the exit price and chart prices == broker prices.
  // A far final target (6R) so that trailing, not the target, decides many trades; three seeds give enough of them.
  const cfgT = busy({ spread: 0, slippage: 0, commissionPerLot: 0, finalTpR: 6 });
  const cases = [42, 7, 99, 5, 123].flatMap((seed) => {
    const series = randomM15(3200, seed);
    const run = runBacktest(aggregateToH1(series, Number.MAX_SAFE_INTEGER), series, cfgT);
    return run.trades.filter((t) => t.maxFavorableR >= cfgT.trailStartR && t.endedBy !== 'end_of_data').map((t) => ({ seed, series, t }));
  });

  it('there are enough trades that reached the trailing level, and some ended on the trailed stop', () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.t.endedBy === 'trail').length).toBeGreaterThan(8);
  });

  it('at every candle the live trail equals what the strategy function says for the real entry candle; the final stop equals the backtest exit', () => {
    let trailMoves = 0;
    for (const { seed, series, t } of cases) {
      const d = t.direction;
      const key = gapKey(t.timeframe, { time: t.poi.fvgTime });
      const label = `seed ${seed} trade ${t.id}`;
      let sl = t.stopLoss;
      let moves = 0;
      for (let c = t.entryIdx + 1; c <= t.exitIdx - 1; c++) {
        // the EA moves the stop to breakeven the moment price reaches the partial level
        const b = series[c];
        if (d === 1 ? b.high >= t.entryLevel + cfgT.partialAtR * t.riskPerUnit : b.low <= t.entryLevel - cfgT.partialAtR * t.riskPerUnit) {
          sl = d === 1 ? Math.max(sl, t.entryLevel) : Math.min(sl, t.entryLevel);
        }
        const pos = { ticket: 1, direction: d, volume: t.lots, openPrice: t.entryLevel, sl, tp: 0, openTime: series[t.entryIdx].time + 60_000, key };
        const part = at(series, c);
        const dec = decideLive(part, state(closeOf(series, c), 10_000, { spreadNow: 0, positions: [pos] }), cfgT, MIN);
        const tr = dec.actions.find((a) => a.type === 'trail');

        // independent expectation straight from the strategy function, anchored on the entry CANDLE's open time
        const fav = d === 1 ? Math.max(...part.slice(t.entryIdx + 1).map((x) => x.high)) : Math.min(...part.slice(t.entryIdx + 1).map((x) => x.low));
        const trailing = d === 1 ? fav >= t.entryLevel + cfgT.trailStartR * t.riskPerUnit : fav <= t.entryLevel - cfgT.trailStartR * t.riskPerUnit;
        const want = trailing
          ? trailCandidate({ trailing: true, direction: d, entryTime: series[t.entryIdx].time, stop: sl }, detectAll(part, M, cfgT).swings, c, series[c].close, cfgT)
          : null;
        if (tr && tr.type === 'trail') {
          expect(want, `${label} candle ${c}: live trailed but the strategy would not`).not.toBeNull();
          expect(Math.abs(tr.sl - want!), `${label} candle ${c}`).toBeLessThanOrEqual(0.0051);
          sl = tr.sl;
          moves++;
          trailMoves++;
        } else if (want !== null) {
          expect(Math.abs(want - sl), `${label} candle ${c}: the strategy would have trailed, live did not`).toBeLessThan(0.0111); // only sub-tick improvements may be skipped
        }
      }
      if (t.endedBy === 'trail') {
        const fill = t.exits[t.exits.length - 1];
        const gapFill = Math.abs(fill.price - series[t.exitIdx].open) < 1e-9; // a gap through the stop fills at the open, not at the stop
        expect(moves, label).toBeGreaterThan(0); // trailing really happened live, it is not just the breakeven stop
        if (!gapFill) expect(Math.abs(sl - fill.price), label).toBeLessThanOrEqual(0.0111); // ticks of 0.01
      }
    }
    expect(trailMoves).toBeGreaterThan(15);
  });
});

describe('trailing: a swing formed on the entry candle itself counts', () => {
  // The hand-built scenario from backtest.test.ts (fractalN = 1): a bullish gap [99.5, 101], entry on candle 7 whose low
  // (100.5) is itself a confirmed swing low, and a run to +2R on candle 9. If the stop is still at its initial level
  // (e.g. the EA was off and missed the breakeven move), the first trail must be that entry-candle swing low.
  const rows: Array<[number, number, number, number]> = [
    // (two opens differ from the backtest fixture, which has opens outside their own candle's range; the live engine rejects those)
    [99, 100, 98, 99], [99, 99.5, 96, 97], [97.5, 104, 97.5, 103], [103, 108, 101, 107], [107, 110, 106, 109], [109, 109, 105, 106],
    [106, 106, 103, 104], [104, 104, 100.5, 101], [101.5, 103, 101.5, 102.8], [102.8, 106, 102, 105.5],
  ];
  const bars: Candle[] = rows.map(([open, high, low, close], i) => ({ time: T0 + i * M, open, high, low, close, volume: 0 }));
  const cfgH = busy({ fractalN: 1, fvgMinSize: 0.5, fvgMinAtrMult: 0, poiTimeframes: 'm15', minErlR: 3, spread: 0, slippage: 0, commissionPerLot: 0, riskPct: 1.5 });
  const key = gapKey('M15', { time: T0 + 2 * M }); // the gap's middle candle is candle 2
  const pos = { ticket: 1, direction: 1 as const, volume: 1, openPrice: 101, sl: 99.5, tp: 105.5, openTime: T0 + 7 * M + 60_000, key };

  it('trails to the entry candle low', () => {
    const d = decideLive(bars, state(T0 + 10 * M, 10_000, { spreadNow: 0, positions: [pos] }), cfgH, { minBars: 10 });
    expect(d.plans).toHaveLength(1); // the gap was found, so this really is the trailing code path
    expect(d.actions).toEqual([{ type: 'trail', ticket: 1, sl: 100.5 }]);
  });

  it('does not trail before +2R has been reached by a later candle', () => {
    const d = decideLive(bars.slice(0, 9), state(T0 + 9 * M, 10_000, { spreadNow: 0, positions: [pos] }), cfgH, { minBars: 9 });
    expect(d.plans).toHaveLength(1);
    expect(d.actions).toEqual([]); // candle 8 only reached +1.0R (103 vs the 104 needed)
  });
});
