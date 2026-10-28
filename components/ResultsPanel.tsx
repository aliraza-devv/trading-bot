'use client';

import { useMemo, useState } from 'react';
import type { BacktestResult } from '@engine/backtest';
import type { Metrics } from '@engine/metrics';
import type { SkipReason, Trade } from '@engine/types';
import { buildEquityFigure, buildRDistFigure } from '@/lib/buildFigure';
import { SKIP_TEXT } from '@/lib/skipText';
import { downloadText, tradesToCsv } from '@/lib/tradesCsv';
import { PlotlyChart } from './PlotlyChart';

const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rr = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

type SortKey = 'id' | 'dir' | 'tf' | 'entry' | 'exit' | 'held' | 'r' | 'pnl' | 'reason' | 'best';
const SORT: Record<SortKey, (t: Trade) => number | string> = {
  id: (t) => t.id, dir: (t) => t.direction, tf: (t) => t.timeframe, entry: (t) => t.entry.time,
  exit: (t) => t.exits[t.exits.length - 1].time, held: (t) => t.exitIdx - t.entryIdx, r: (t) => t.rMultiple,
  pnl: (t) => t.pnl, reason: (t) => t.endedBy, best: (t) => t.maxFavorableR,
};

interface Props {
  result: BacktestResult;
  metrics: Metrics;
  ms: number;
  stale: boolean;
  running: boolean;
  selectedId: number | null;
  onSelect: (t: Trade) => void;
  onRerun: () => void;
  finalTpR: number;
}

export function ResultsPanel({ result, metrics: m, ms, stale, running, selectedId, onSelect, onRerun }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'entry', asc: true });
  const trades = useMemo(() => {
    const f = SORT[sort.key];
    return [...result.trades].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.asc ? 1 : -1);
    });
  }, [result.trades, sort]);

  const equityFig = useMemo(() => buildEquityFigure(result.equity, result.startEquity), [result]);
  const distFig = useMemo(() => buildRDistFigure(m.rDistribution), [m]);
  const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);
  const openAtEnd = result.trades.filter((t) => t.endedBy === 'end_of_data').length;

  const cards: Array<[string, string, string]> = [
    ['Trades', String(m.trades), `${m.wins} won · ${m.losses} lost · ${m.breakeven} flat`],
    ['Win rate', `${(m.winRate * 100).toFixed(1)}%`, 'trades closed above breakeven'],
    ['Expectancy', rr(m.expectancyR), 'average result per trade, after costs'],
    ['Profit factor', m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2), 'R won ÷ R lost'],
    ['Net P&L', usd(m.netPnlUsd), `${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(1)}% → ${usd(m.endEquity)}`],
    ['Max drawdown', `${m.maxDrawdownPct.toFixed(1)}%`, `${usd(m.maxDrawdownUsd)} · ${m.maxDrawdownR.toFixed(1)}R`],
    ['Avg win / loss', `${rr(m.avgWinR)} / ${rr(m.avgLossR)}`, 'size of a typical winner / loser'],
    ['Best / worst', `${rr(m.bestR)} / ${rr(m.worstR)}`, 'single trades'],
    ['Longest losing run', String(m.longestLosingStreak), 'losses in a row'],
    ['Avg time in trade', `${((m.avgDurationBars * 15) / 60).toFixed(1)} h`, 'entry to last exit'],
  ];

  const header = (key: SortKey, label: string, right = false) => (
    <th scope="col" className={`cursor-pointer select-none whitespace-nowrap px-2 py-1 font-medium hover:text-white ${right ? 'text-right' : 'text-left'}`}
      onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}
      aria-sort={sort.key === key ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <section className="mt-6 space-y-5" aria-label="Backtest results">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Results</h2>
        <span className="text-sm text-zinc-500">computed in {ms} ms in a background worker</span>
        {stale && (
          <span role="status" className="rounded border border-orange-600 bg-orange-950/40 px-2 py-0.5 text-sm">
            Settings or data changed since this run.{' '}
            <button type="button" className="underline" disabled={running} onClick={onRerun}>Run again</button>
          </span>
        )}
        <button type="button" disabled={!result.trades.length}
          onClick={() => downloadText('trades.csv', tradesToCsv(result.trades))}
          className="ml-auto rounded border border-zinc-600 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40">
          Download trades CSV
        </button>
      </div>

      {m.trades < 30 && (
        <p className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
          {m.trades === 0 ? 'No trades were taken. ' : `Only ${m.trades} trade${m.trades === 1 ? '' : 's'}: `}
          {m.trades === 0 ? 'See "Setups that were skipped" below for why. ' : 'too few to trust win rate or expectancy (aim for 100 or more across different market conditions). '}
          Try a longer date range or looser setup rules.
        </p>
      )}
      {openAtEnd > 0 && (
        <p className="text-sm text-zinc-400">{openAtEnd} trade was still open when the data ended and was closed at the last price (exit reason “end_of_data”).</p>
      )}

      <dl className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        {cards.map(([label, value, sub]) => (
          <div key={label} className="rounded border border-zinc-800 p-3">
            <dt className="text-xs uppercase tracking-wide text-zinc-400">{label}</dt>
            <dd className="mt-1 text-xl font-semibold">{value}</dd>
            <dd className="text-xs text-zinc-500">{sub}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm text-zinc-400">
        By gap timeframe: H1 {m.byTimeframe.H1.trades} trades ({(m.byTimeframe.H1.winRate * 100).toFixed(0)}% won, avg {rr(m.byTimeframe.H1.avgR)}) · M15 {m.byTimeframe.M15.trades} trades ({(m.byTimeframe.M15.winRate * 100).toFixed(0)}% won, avg {rr(m.byTimeframe.M15.avgR)}).
        {' '}By direction: long {m.byDirection.long.trades} ({(m.byDirection.long.winRate * 100).toFixed(0)}% won, avg {rr(m.byDirection.long.avgR)}) · short {m.byDirection.short.trades} ({(m.byDirection.short.winRate * 100).toFixed(0)}% won, avg {rr(m.byDirection.short.avgR)}).
      </p>

      <div className="grid gap-4 xl:grid-cols-2">
        <PlotlyChart data={equityFig.data} layout={equityFig.layout} />
        <PlotlyChart data={distFig.data} layout={distFig.layout} />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold">Setups that were skipped ({skippedTotal} of {result.touched} touched gaps)</h3>
        {skippedTotal === 0 ? <p className="text-sm text-zinc-500">None - every touched gap became a trade.</p> : (
          <ul className="grid gap-x-6 text-sm text-zinc-300 md:grid-cols-2">
            {(Object.entries(result.skipped) as Array<[SkipReason, number]>).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([k, c]) => (
              <li key={k}><span className="inline-block w-10 text-right font-medium">{c}</span> {SKIP_TEXT[k]}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold">Trades <span className="font-normal text-zinc-500">- click a header to sort, click a row to zoom the chart to it</span></h3>
        <div className="max-h-[420px] overflow-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-300">
              <tr>
                {header('id', '#')}{header('dir', 'Side')}{header('tf', 'Gap')}{header('entry', 'Entry (UTC)')}{header('exit', 'Exit (UTC)')}
                {header('held', 'Held', true)}{header('r', 'Result', true)}{header('pnl', 'P&L', true)}{header('best', 'Best', true)}{header('reason', 'Ended by')}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} onClick={() => onSelect(t)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t); } }}
                  className={`cursor-pointer border-t border-zinc-800 hover:bg-zinc-800 ${selectedId === t.id ? 'bg-zinc-700' : ''}`}>
                  <td className="px-2 py-1">{t.id}</td>
                  <td className="px-2 py-1">{t.direction === 1 ? 'Long' : 'Short'}</td>
                  <td className="px-2 py-1">{t.timeframe}</td>
                  <td className="whitespace-nowrap px-2 py-1">{when(t.entry.time)}</td>
                  <td className="whitespace-nowrap px-2 py-1">{when(t.exits[t.exits.length - 1].time)}</td>
                  <td className="px-2 py-1 text-right">{(((t.exitIdx - t.entryIdx) * 15) / 60).toFixed(1)} h</td>
                  <td className={`px-2 py-1 text-right font-medium ${t.rMultiple > 0 ? 'text-green-500' : 'text-red-400'}`}>{rr(t.rMultiple)}</td>
                  <td className={`px-2 py-1 text-right ${t.pnl > 0 ? 'text-green-500' : 'text-red-400'}`}>{usd(t.pnl)}</td>
                  <td className="px-2 py-1 text-right text-zinc-400">{t.maxFavorableR.toFixed(1)}R</td>
                  <td className="px-2 py-1">{t.endedBy.replace('_', ' ')}</td>
                </tr>
              ))}
              {trades.length === 0 && <tr><td colSpan={10} className="px-2 py-4 text-center text-zinc-500">No trades</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
