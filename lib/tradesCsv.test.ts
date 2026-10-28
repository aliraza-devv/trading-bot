import { describe, expect, it } from 'vitest';
import type { Fill, Trade } from '@engine/types';
import { CSV_COLUMNS, tradesToCsv } from './tradesCsv';

const T = Date.UTC(2025, 2, 3, 9, 30);
const fill = (time: number, price: number, lots: number, reason: Fill['reason']): Fill => ({ time, price, lots, reason, commission: 0, pnl: 0 });

const trade = {
  id: 7, direction: -1, timeframe: 'H1', entryIdx: 10, exitIdx: 14,
  poi: { bottom: 2900.1, top: 2901.55, erl: 2880 },
  entry: fill(T, 2900.1234, 1, 'entry'),
  exits: [fill(T + 900_000, 2899, 0.5, 'partial'), fill(T + 3_600_000, 2897, 0.5, 'target')],
  stopLoss: 2902.05, lots: 1, riskUsd: 195, rMultiple: 1.23456, pnl: 240.5, commission: 7, endedBy: 'target', maxFavorableR: 3.1,
} as unknown as Trade;

describe('tradesToCsv', () => {
  it('writes a header and one row per trade with the same number of columns', () => {
    const lines = tradesToCsv([trade, trade]).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].split(',')).toEqual([...CSV_COLUMNS]);
    for (const l of lines.slice(1)) expect(l.split(',')).toHaveLength(CSV_COLUMNS.length);
  });

  it('formats the values: UTC times, lot-weighted exit price, rounded numbers, readable words', () => {
    const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, tradesToCsv([trade]).trim().split('\n')[1].split(',')[i]]));
    expect(row).toMatchObject({
      id: '7', direction: 'short', gap_timeframe: 'H1',
      entry_time_utc: '2025-03-03 09:30:00', exit_time_utc: '2025-03-03 10:30:00',
      entry_price: '2900.12', avg_exit_price: '2898', stop_loss: '2902.05', erl_price: '2880',
      r_multiple: '1.235', pnl_usd: '240.5', exit_reason: 'target', partial_taken: 'yes', bars_held_m15: '4',
    });
  });

  it('is just a header for no trades', () => {
    expect(tradesToCsv([]).trim()).toBe(CSV_COLUMNS.join(','));
  });
});
