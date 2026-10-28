/**
 * metrics.ts - summary statistics for a list of finished trades (in the order they closed).
 *
 * "R" = the trade's net result divided by its initial risk, after ALL costs. Profit factor is computed
 * in R (gross R won / gross R lost) so it is not distorted by the position size growing with equity.
 */
import type { Trade } from './types';

export interface BucketStats {
  trades: number;
  winRate: number;
  avgR: number;
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number; // |R| < 0.005
  winRate: number; // wins / trades (0..1)
  expectancyR: number; // average R per trade
  avgWinR: number;
  avgLossR: number; // negative
  profitFactor: number; // gross R won / gross R lost; Infinity if nothing was lost, 0 if nothing was won
  netPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number; // positive number
  endEquity: number;
  returnPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number; // of the equity peak
  maxDrawdownR: number; // peak-to-trough of cumulative R
  longestLosingStreak: number;
  bestR: number;
  worstR: number;
  avgDurationBars: number; // M15 candles from entry to last exit
  rDistribution: Array<{ label: string; from: number; to: number; count: number }>;
  byTimeframe: Record<'H1' | 'M15', BucketStats>;
  byDirection: Record<'long' | 'short', BucketStats>;
}

const BE_BAND = 0.005;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function bucket(ts: Trade[]): BucketStats {
  return {
    trades: ts.length,
    winRate: ts.length ? ts.filter((t) => t.rMultiple > BE_BAND).length / ts.length : 0,
    avgR: mean(ts.map((t) => t.rMultiple)),
  };
}

/** R histogram in 0.5R bins from -2R to +4R, with open-ended first and last bins. */
export function rDistribution(trades: Trade[]): Metrics['rDistribution'] {
  const edges: number[] = [];
  for (let e = -2; e <= 4; e += 0.5) edges.push(e);
  const bins = [{ label: '< -2', from: -Infinity, to: -2, count: 0 }];
  for (let i = 0; i + 1 < edges.length; i++) {
    bins.push({ label: `${edges[i]} to ${edges[i + 1]}`, from: edges[i], to: edges[i + 1], count: 0 });
  }
  bins.push({ label: '>= 4', from: 4, to: Infinity, count: 0 });
  for (const t of trades) {
    const b = bins.find((x) => t.rMultiple >= x.from && t.rMultiple < x.to);
    if (b) b.count++;
  }
  return bins;
}

export function computeMetrics(trades: Trade[], startEquity: number): Metrics {
  const rs = trades.map((t) => t.rMultiple);
  const winsT = trades.filter((t) => t.rMultiple > BE_BAND);
  const lossT = trades.filter((t) => t.rMultiple < -BE_BAND);
  const grossWinR = winsT.reduce((a, t) => a + t.rMultiple, 0);
  const grossLossR = -lossT.reduce((a, t) => a + t.rMultiple, 0);

  // Drawdown on realised equity (USD, % of peak) and on cumulative R, in closing order.
  let eq = startEquity;
  let peak = startEquity;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    maxDdUsd = Math.max(maxDdUsd, peak - eq);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? (peak - eq) / peak : 0);
    cumR += t.rMultiple;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
    streak = t.rMultiple < -BE_BAND ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  const grossProfitUsd = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLossUsd = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);

  return {
    trades: trades.length,
    wins: winsT.length,
    losses: lossT.length,
    breakeven: trades.length - winsT.length - lossT.length,
    winRate: trades.length ? winsT.length / trades.length : 0,
    expectancyR: mean(rs),
    avgWinR: mean(winsT.map((t) => t.rMultiple)),
    avgLossR: mean(lossT.map((t) => t.rMultiple)),
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? Infinity : 0,
    netPnlUsd: eq - startEquity,
    grossProfitUsd,
    grossLossUsd,
    endEquity: eq,
    returnPct: startEquity > 0 ? ((eq - startEquity) / startEquity) * 100 : 0,
    maxDrawdownUsd: maxDdUsd,
    maxDrawdownPct: maxDdPct * 100,
    maxDrawdownR: maxDdR,
    longestLosingStreak: longest,
    bestR: rs.length ? Math.max(...rs) : 0,
    worstR: rs.length ? Math.min(...rs) : 0,
    avgDurationBars: mean(trades.map((t) => t.exitIdx - t.entryIdx)),
    rDistribution: rDistribution(trades),
    byTimeframe: { H1: bucket(trades.filter((t) => t.timeframe === 'H1')), M15: bucket(trades.filter((t) => t.timeframe === 'M15')) },
    byDirection: { long: bucket(trades.filter((t) => t.direction === 1)), short: bucket(trades.filter((t) => t.direction === -1)) },
  };
}
