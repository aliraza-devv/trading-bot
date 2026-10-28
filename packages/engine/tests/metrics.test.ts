import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../metrics';
import type { Trade } from '../types';

/** Only the fields metrics reads; everything else is irrelevant here. */
function trade(r: number, over: Partial<Trade> = {}): Trade {
  return { rMultiple: r, pnl: r * 100, timeframe: 'M15', direction: 1, entryIdx: 0, exitIdx: 4, ...over } as Trade;
}

describe('computeMetrics', () => {
  // R: +2, -1, -1, +0.5, -1, +3   (pnl = R x 100)
  const trades = [trade(2), trade(-1), trade(-1, { direction: -1 }), trade(0.5, { timeframe: 'H1' }), trade(-1), trade(3)];
  const m = computeMetrics(trades, 10_000);

  it('counts, win rate and expectancy', () => {
    expect([m.trades, m.wins, m.losses, m.breakeven]).toEqual([6, 3, 3, 0]);
    expect(m.winRate).toBe(0.5);
    expect(m.expectancyR).toBeCloseTo(2.5 / 6);
    expect(m.avgWinR).toBeCloseTo(5.5 / 3);
    expect(m.avgLossR).toBe(-1);
    expect([m.bestR, m.worstR]).toEqual([3, -1]);
  });

  it('profit factor is gross R won over gross R lost', () => {
    expect(m.profitFactor).toBeCloseTo(5.5 / 3);
  });

  it('equity, return and drawdown follow the closing order', () => {
    // equity: 10200, 10100, 10000, 10050, 9950, 10250 -> peak 10200, trough 9950
    expect(m.netPnlUsd).toBe(250);
    expect(m.endEquity).toBe(10_250);
    expect(m.returnPct).toBeCloseTo(2.5);
    expect(m.maxDrawdownUsd).toBe(250);
    expect(m.maxDrawdownPct).toBeCloseTo((250 / 10_200) * 100);
    // cumulative R: 2, 1, 0, 0.5, -0.5, 2.5 -> peak 2, trough -0.5
    expect(m.maxDrawdownR).toBe(2.5);
    expect(m.longestLosingStreak).toBe(2);
  });

  it('splits by timeframe and direction', () => {
    expect(m.byTimeframe.H1).toEqual({ trades: 1, winRate: 1, avgR: 0.5 });
    expect(m.byTimeframe.M15.trades).toBe(5);
    expect(m.byDirection.short).toEqual({ trades: 1, winRate: 0, avgR: -1 });
  });

  it('builds the R distribution (every trade lands in exactly one bin)', () => {
    const byLabel = Object.fromEntries(m.rDistribution.map((b) => [b.label, b.count]));
    expect(byLabel['-1 to -0.5']).toBe(3);
    expect(byLabel['0.5 to 1']).toBe(1);
    expect(byLabel['2 to 2.5']).toBe(1);
    expect(byLabel['3 to 3.5']).toBe(1);
    expect(m.rDistribution.reduce((a, b) => a + b.count, 0)).toBe(6);
  });

  it('handles no trades without NaN, and all-winners profit factor', () => {
    const e = computeMetrics([], 10_000);
    expect([e.trades, e.winRate, e.expectancyR, e.profitFactor, e.maxDrawdownUsd, e.endEquity]).toEqual([0, 0, 0, 0, 0, 10_000]);
    expect(computeMetrics([trade(1), trade(2)], 10_000).profitFactor).toBe(Infinity);
  });

  it('treats a result within 0.005R of zero as breakeven', () => {
    const b = computeMetrics([trade(0.003), trade(-0.004), trade(1)], 10_000);
    expect([b.wins, b.losses, b.breakeven]).toEqual([1, 0, 2]);
  });
});
