/**
 * Strategy rule tests: trade management, costs, sizing, ERL and priority - each on tiny hand-made
 * inputs with answers worked out by hand. Costs are zeroed in most tests so the numbers stay readable.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../config';
import {
  buyPrice, findErl, inWindow, manageBar, openPosition, sellPrice, sessionAllows, sizePosition, sortByPriority,
  spreadAt, toTrade, trailCandidate, type Candidate, type Position, type Setup,
} from '../strategy';
import type { Candle, Direction, FVG, Swing } from '../types';

const T0 = Date.UTC(2025, 0, 6, 10);
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * 900_000, open: o, high: h, low: l, close: c, volume: 0 });

/** No costs, no buffer, no session filter: R numbers come out exact. */
const free = (o: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG, spread: 0, spreadWindows: [], slippage: 0, commissionPerLot: 0, slBuffer: 0,
  sessionFilterEnabled: false, ...o,
});

const poi = { timeframe: 'M15' as const, direction: 1 as Direction, fvgConfirmIdx: 0, fvgTime: T0, confirmTime: T0, bottom: 0, top: 0, erl: 0, erlTime: T0 };
/** 1R = 1.00 and exactly 1.00 lot at 1% risk of 10,000. Long: 100 -> stop 99; short: 100 -> stop 101. */
const setup = (d: Direction, lots = 1): Setup => ({
  timeframe: 'M15', direction: d, poi: { ...poi, direction: d }, level: 100, stop: d === 1 ? 99 : 101, risk: 1, lots,
});
const open = (d: Direction, cfg: Config, entry = bar(0, 100.4, 100.6, 100, 100.5), lots = 1): Position =>
  openPosition(setup(d, lots), entry, 0, 1, cfg);

describe('trade management - long', () => {
  it('stops out for -1R', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(0, 100.4, 100.6, 100, 100.5), true, c); // entry candle, stop not touched
    expect(p.closed).toBe(false);
    manageBar(p, bar(1, 100.5, 100.6, 98.9, 99.2), false, c);
    const t = toTrade(p, 1, c);
    expect([p.closed, t.endedBy, t.rMultiple, t.pnl]).toEqual([true, 'stop', -1, -100]);
  });

  it('the entry candle can only stop you out - it never takes a target', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(0, 100.4, 105, 100, 104), true, c); // would have reached +3R
    expect(p.closed).toBe(false);
    expect(p.fills).toHaveLength(1);
    const q = open(1, c, bar(0, 100.4, 100.6, 98.9, 99.5));
    manageBar(q, bar(0, 100.4, 100.6, 98.9, 99.5), true, c); // low hits the stop on the entry candle
    expect(toTrade(q, 0, c).rMultiple).toBe(-1);
  });

  it('+1R closes half and moves the stop to breakeven, which then exits at 0 for +0.5R', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 101.2, 100.3, 101), false, c);
    expect([p.partialTaken, p.lotsLeft, p.stop, p.closed]).toEqual([true, 0.5, 100, false]);
    manageBar(p, bar(2, 101, 101.1, 99.9, 100.2), false, c);
    const t = toTrade(p, 2, c);
    expect([t.endedBy, t.rMultiple, t.pnl]).toEqual(['breakeven', 0.5, 50]);
  });

  it('pessimistic: a candle that reaches +1R and falls back to breakeven exits at breakeven in the same candle', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 101.5, 99.9, 100.4), false, c);
    expect([p.closed, toTrade(p, 1, c).rMultiple]).toEqual([true, 0.5]);
  });

  it('pessimistic: if one candle could hit both stop and target, the stop wins', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 101.5, 98.9, 100), false, c);
    expect([p.partialTaken, toTrade(p, 1, c).rMultiple]).toEqual([false, -1]);
  });

  it('pessimistic: a candle spanning the stop AND the final target is a full -1R loss, not a win', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 103.5, 98.9, 100), false, c); // low <= 99 stop, high >= 103 (+3R)
    const t = toTrade(p, 1, c);
    expect([t.endedBy, t.rMultiple, p.partialTaken]).toEqual(['stop', -1, false]);
  });

  it('runs to the final target: 0.5 x 1R + 0.5 x 3R = +2R', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 101.2, 100.3, 101), false, c);
    manageBar(p, bar(2, 101, 103.2, 100.9, 103), false, c);
    const t = toTrade(p, 2, c);
    expect([t.endedBy, t.rMultiple, t.pnl, p.trailing]).toEqual(['target', 2, 200, true]);
  });

  it('a candle that gaps through the stop fills at its open (worse than the stop)', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 98.5, 98.9, 98.4, 98.6), false, c);
    expect(toTrade(p, 1, c).rMultiple).toBe(-1.5);
  });

  it('a candle that gaps through targets fills at its open (better than the target)', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 103.5, 104, 103.4, 103.8), false, c); // opens above +3R
    // partial at 103.5 (+3.5R on half = +175) and final at 103.5 (+175)
    expect(toTrade(p, 1, c).rMultiple).toBe(3.5);
  });

  it('a target the ENTRY candle already traded through fills at the level, not at a better gap open next candle', () => {
    const c = free();
    const entry = bar(0, 100.4, 103.5, 100, 103.4); // traded through +1R, +2R and +3R, then closed up there
    const p = open(1, c, entry);
    manageBar(p, entry, true, c); // entry candle: only the stop can act
    expect(p.closed).toBe(false);
    manageBar(p, bar(1, 103.6, 104, 103.4, 103.8), false, c); // opens beyond +3R
    // partial at 101 (+0.5R) and final at 103 (+1.5R) = +2R - NOT 3.6R from filling at the open
    expect(toTrade(p, 1, c).rMultiple).toBeCloseTo(2, 9);
  });

  it('trails the stop to the latest confirmed swing low and exits there', () => {
    const c = free();
    const p = open(1, c);
    manageBar(p, bar(1, 100.5, 101.2, 100.3, 101), false, c); // partial + breakeven
    manageBar(p, bar(2, 101, 102.4, 101.2, 102.2), false, c); // reaches +2R: trailing on, no target yet
    expect([p.trailing, p.stop]).toEqual([true, 100]);
    const swing: Swing = { kind: 'low', idx: 2, price: 101.5, time: bar(2, 0, 0, 0, 0).time, confirmIdx: 3, confirmTime: 0 };
    expect(trailCandidate(p, [swing], 3, 102.2, c)).toBe(101.5);
    p.stop = 101.5;
    manageBar(p, bar(3, 102.2, 102.3, 101.4, 101.6), false, c);
    const t = toTrade(p, 3, c);
    expect([t.endedBy, t.rMultiple]).toEqual(['trail', 1.25]); // 0.5 x 1R + 0.5 x 1.5R
  });
});

describe('trailing stop rule', () => {
  const c = free();
  const trailing = () => {
    const p = open(1, c);
    p.trailing = true;
    p.stop = 100;
    return p;
  };
  const sw = (kind: 'low' | 'high', idx: number, price: number, confirmIdx: number): Swing => ({
    kind, idx, price, time: bar(idx, 0, 0, 0, 0).time, confirmIdx, confirmTime: 0,
  });

  it('does nothing until trailing is on', () => {
    const p = open(1, c);
    expect(trailCandidate(p, [sw('low', 2, 101.5, 3)], 3, 102, c)).toBeNull();
  });
  it('ignores swings that are not confirmed yet, are older than the trade, or would loosen the stop', () => {
    expect(trailCandidate(trailing(), [sw('low', 2, 101.5, 4)], 3, 102, c)).toBeNull(); // confirmed at 4, we are at 3
    expect(trailCandidate(trailing(), [sw('low', -3, 101.5, -2)], 5, 102, c)).toBeNull(); // before entry
    expect(trailCandidate(trailing(), [sw('low', 2, 99.5, 3)], 3, 102, c)).toBeNull(); // below the current stop
  });
  it('ignores the wrong kind of swing and a stop that would sit above the last close', () => {
    expect(trailCandidate(trailing(), [sw('high', 2, 105, 3)], 3, 102, c)).toBeNull();
    expect(trailCandidate(trailing(), [sw('low', 2, 103, 3)], 3, 102, c)).toBeNull();
  });
  it('uses only the MOST RECENT matching swing, even if an older one is higher', () => {
    expect(trailCandidate(trailing(), [sw('low', 2, 101.8, 3), sw('low', 4, 101.1, 5)], 5, 102.5, c)).toBe(101.1);
    expect(trailCandidate(trailing(), [sw('low', 2, 101.8, 3), sw('low', 4, 99.9, 5)], 5, 102.5, c)).toBeNull();
  });
  it('applies the SL buffer beyond the swing', () => {
    expect(trailCandidate(trailing(), [sw('low', 2, 101.5, 3)], 3, 102, free({ slBuffer: 0.3 }))).toBeCloseTo(101.2);
  });
});

describe('trade management - short (mirror image)', () => {
  it('stops out at -1R and wins +2R on the same path mirrored', () => {
    const c = free();
    const lose = open(-1, c, bar(0, 99.6, 100, 99.4, 99.5));
    manageBar(lose, bar(1, 99.5, 101.2, 99.4, 101), false, c);
    expect(toTrade(lose, 1, c).rMultiple).toBe(-1);

    const win = open(-1, c, bar(0, 99.6, 100, 99.4, 99.5));
    manageBar(win, bar(1, 99.5, 99.7, 98.8, 99), false, c); // +1R at 99
    expect([win.partialTaken, win.stop]).toEqual([true, 100]);
    manageBar(win, bar(2, 99, 99.1, 96.8, 97), false, c); // +3R at 97
    expect(toTrade(win, 2, c).rMultiple).toBe(2);
  });
});

describe('costs', () => {
  it('buys at the ask and sells at the bid, and slippage always hurts', () => {
    expect(buyPrice(100, 0.4, 0.1)).toBeCloseTo(100.3);
    expect(sellPrice(100, 0.4, 0.1)).toBeCloseTo(99.7);
  });

  it('charges spread, slippage and commission on every fill: a stopped long loses 1.67R', () => {
    const c = free({ spread: 0.4, slippage: 0.1, commissionPerLot: 3.5 });
    const p = open(1, c);
    expect(p.entryFill).toBeCloseTo(100.3);
    manageBar(p, bar(1, 100.5, 100.6, 98.9, 99.2), false, c);
    const t = toTrade(p, 1, c);
    // exit at 99 - 0.2 - 0.1 = 98.7 -> (98.7 - 100.3) x 100 = -160, commission 3.5 x (1 + 1) = 7
    expect(t.pnl).toBeCloseTo(-167);
    expect(t.commission).toBeCloseTo(7);
    expect(t.rMultiple).toBeCloseTo(-1.67);
  });
});

describe('sizing, windows, spread schedule', () => {
  it('sizes to the risk budget and rounds DOWN to the lot step', () => {
    const c = free();
    expect(sizePosition(10_000, 1.5, c)).toBe(0.66); //  100 / (1.5 x 100) = 0.666
    expect(sizePosition(10_000, 100, c)).toBe(0.01); //  exactly the minimum
    expect(sizePosition(10_000, 200, c)).toBe(0); //     0.005 lots is not tradable
    expect(sizePosition(0, 1, c)).toBe(0);
  });

  it('time windows, including ones that wrap midnight', () => {
    const at = (h: number, m = 0) => Date.UTC(2025, 0, 6, h, m);
    expect(inWindow(at(7), '07:00', '20:00')).toBe(true);
    expect(inWindow(at(20), '07:00', '20:00')).toBe(false); // end is exclusive
    expect(inWindow(at(23), '22:00', '02:00')).toBe(true);
    expect(inWindow(at(1, 59), '22:00', '02:00')).toBe(true);
    expect(inWindow(at(12), '22:00', '02:00')).toBe(false);
    expect(sessionAllows(at(3), free())).toBe(true); // filter off
    expect(sessionAllows(at(3), free({ sessionFilterEnabled: true }))).toBe(false);
  });

  it('uses the first matching spread window, else the normal spread', () => {
    const c = free({ spread: 0.3, spreadWindows: [['21:00', '23:00', 1.0]] });
    expect(spreadAt(Date.UTC(2025, 0, 6, 22), c)).toBe(1);
    expect(spreadAt(Date.UTC(2025, 0, 6, 12), c)).toBe(0.3);
  });
});

describe('ERL and priority', () => {
  const fvg = (direction: Direction, idxMid: number, bottom: number, top: number, confirmIdx = idxMid + 1, tf = 0): FVG & { tf: number } => ({
    direction, bottom, top, size: top - bottom, ce: (top + bottom) / 2, idxFirst: idxMid - 1, idxMid, confirmIdx, time: 0, confirmTime: 0,
    firstTouchIdx: -1, fillIdx: -1, closeIdx: -1, endIdx: -1, endReason: 'open', tf,
  });
  const s = (kind: 'high' | 'low', idx: number, price: number, confirmIdx: number): Swing => ({ kind, idx, price, time: 0, confirmIdx, confirmTime: 0 });
  const swings = [s('high', 2, 120, 4), s('low', 4, 95, 6), s('high', 5, 108, 7), s('high', 9, 112, 11), s('low', 10, 90, 12)];

  it('long: highest CONFIRMED swing high at/after the gap and above it; later pivots are not known yet', () => {
    const f = fvg(1, 3, 100, 101);
    expect(findErl(1, f, swings, 8)?.price).toBe(108); //  the 112 swing is confirmed at 11
    expect(findErl(1, f, swings, 11)?.price).toBe(112);
    expect(findErl(1, f, swings, 6)).toBeNull(); //         nothing confirmed after the gap yet
  });
  it('ignores swings from before the gap and swings that are not beyond it', () => {
    expect(findErl(1, fvg(1, 3, 100, 109), swings, 11)?.price).toBe(112); // 108 is not above the 109 top
    expect(findErl(1, fvg(1, 6, 100, 101), swings, 11)?.price).toBe(112); // 108 pivot (idx 5) is before the middle candle
  });
  it('short: lowest confirmed swing low after the gap and below it', () => {
    expect(findErl(-1, fvg(-1, 3, 100, 101), swings, 12)?.price).toBe(90);
    expect(findErl(-1, fvg(-1, 3, 100, 101), swings, 8)?.price).toBe(95);
  });

  it('H1 gaps come before M15 gaps; within a timeframe the newest gap first', () => {
    const mk = (tf: 'H1' | 'M15', confirmIdx: number): Candidate => ({ tf, fvg: fvg(1, confirmIdx - 1, 1, 2, confirmIdx) });
    const order = sortByPriority([mk('M15', 50), mk('H1', 10), mk('M15', 60), mk('H1', 20)]).map((c) => `${c.tf}${c.fvg.confirmIdx}`);
    expect(order).toEqual(['H120', 'H110', 'M1560', 'M1550']);
  });
});
