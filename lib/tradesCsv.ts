import type { Trade } from '@engine/types';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const n = (v: number, dp = 4) => (Number.isFinite(v) ? String(Math.round(v * 10 ** dp) / 10 ** dp) : '');

export const CSV_COLUMNS = [
  'id', 'direction', 'gap_timeframe', 'entry_time_utc', 'exit_time_utc', 'entry_price', 'avg_exit_price', 'stop_loss',
  'erl_price', 'gap_bottom', 'gap_top', 'lots', 'risk_usd', 'r_multiple', 'pnl_usd', 'commission_usd', 'exit_reason',
  'partial_taken', 'bars_held_m15', 'max_favorable_r',
] as const;

/** Trades as CSV text (UTC times, one row per trade). Prices are the actual fills, spread + slippage included. */
export function tradesToCsv(trades: Trade[]): string {
  const rows = trades.map((t) => {
    const lots = t.exits.reduce((a, f) => a + f.lots, 0);
    const avgExit = lots ? t.exits.reduce((a, f) => a + f.price * f.lots, 0) / lots : NaN;
    const last = t.exits[t.exits.length - 1];
    return [
      t.id, t.direction === 1 ? 'long' : 'short', t.timeframe, iso(t.entry.time), iso(last.time),
      n(t.entry.price, 2), n(avgExit, 2), n(t.stopLoss, 2), n(t.poi.erl, 2), n(t.poi.bottom, 2), n(t.poi.top, 2),
      n(t.lots, 2), n(t.riskUsd, 2), n(t.rMultiple, 3), n(t.pnl, 2), n(t.commission, 2), t.endedBy,
      t.exits.some((f) => f.reason === 'partial') ? 'yes' : 'no', t.exitIdx - t.entryIdx, n(t.maxFavorableR, 2),
    ].join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/** Trigger a browser download of `text` as a file. */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
