'use client';

import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONFIG, validateConfig, type Config } from '@engine/config';
import { detectAll } from '@engine/detectors';
import { TF_MS, type Candle, type Structure, type Timeframe, type Trade } from '@engine/types';
import { buildFigure, type Layers } from '@/lib/buildFigure';
import { useBacktest } from '@/lib/useBacktest';
import { ConfigForm } from './ConfigForm';
import { PlotlyChart } from './PlotlyChart';
import { ResultsPanel } from './ResultsPanel';

/** Which stage of the app is live (controls which settings the form shows). */
const LIVE_STAGE = 2;

type Source = 'twelvedata' | 'dukascopy' | 'demo';
interface Loaded { source: Source; from: string; to: string; m15: Candle[]; h1: Candle[] }
type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; code: string; message: string };

const toCandles = (rows: number[][]): Candle[] =>
  rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function Explorer() {
  const [from, setFrom] = useState('2025-02-03');
  const [to, setTo] = useState('2025-03-28');
  const [source, setSource] = useState<Source>('twelvedata');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [data, setData] = useState<Loaded | null>(null);

  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
  const [tf, setTf] = useState<Timeframe>('H1');
  const [layers, setLayers] = useState<Layers>({ swings: true, fvg: true, bos: true, pd: true, trades: true });
  const [size, setSize] = useState<Record<Timeframe, number>>({ H1: 300, M15: 500 });
  const [startIdx, setStartIdx] = useState<number | null>(null); // null = show the latest bars
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const chartTop = useRef<HTMLDivElement>(null);
  const bt = useBacktest();

  async function load(src: Source) {
    setSource(src);
    setStatus({ kind: 'loading' });
    try {
      const res = await fetch(`/api/candles?from=${from}&to=${to}&source=${src}`);
      const body = await res.json();
      if (!res.ok) {
        setStatus({ kind: 'error', code: body.error ?? 'error', message: body.message ?? `HTTP ${res.status}` });
        return;
      }
      setData({ source: src, from, to, m15: toCandles(body.m15), h1: toCandles(body.h1) });
      setStartIdx(null); // new data -> show the latest bars
      setSelectedId(null);
      bt.reset(); // old results belong to the old candles
      setStatus({ kind: 'idle' });
    } catch (e) {
      setStatus({ kind: 'error', code: 'network', message: e instanceof Error ? e.message : 'Network error' });
    }
  }

  // Detectors run on the FULL series of each timeframe; the chart only crops. Typing in the settings
  // form stays responsive because detection reads a deferred copy of the config.
  const dcfg = useDeferredValue(cfg);
  const structures = useMemo<Record<Timeframe, Structure> | null>(
    () => (data ? { H1: detectAll(data.h1, TF_MS.H1, dcfg), M15: detectAll(data.m15, TF_MS.M15, dcfg) } : null),
    [data, dcfg],
  );

  const problems = useMemo(() => validateConfig(cfg), [cfg]);
  const done = bt.state.status === 'done' ? bt.state : null;
  const stale = !!done && (done.data !== data || JSON.stringify(done.cfg) !== JSON.stringify(cfg));
  const running = bt.state.status === 'running';
  const runBacktest = () => { if (data && problems.length === 0) bt.run(data.h1, data.m15, cfg, data); };

  const candles = data ? (tf === 'H1' ? data.h1 : data.m15) : null;
  const n = candles?.length ?? 0;
  const shown = Math.min(size[tf], n);
  const lo = candles ? Math.max(0, Math.min(startIdx ?? n - shown, n - shown)) : 0;
  const hi = lo + shown;

  const overlay = useMemo(
    () => (done ? { trades: done.result.trades, selectedId, finalTpR: done.cfg.finalTpR } : undefined),
    [done, selectedId],
  );
  const figure = useMemo(() => {
    if (!candles || !structures || hi - lo < 3) return null;
    return buildFigure(candles, structures[tf], TF_MS[tf], lo, hi, layers,
      `XAUUSD ${tf} - swings, FVG, BOS, premium/discount${overlay ? ', trades' : ''}`, 760, overlay);
  }, [candles, structures, tf, lo, hi, layers, overlay]);

  /** Click a trade -> show the M15 chart around it (trades are M15-indexed) and select it. */
  function focusTrade(t: Trade) {
    setSelectedId(t.id);
    setTf('M15');
    setSize((s) => ({ ...s, M15: Math.min(500, Math.max(80, t.exitIdx - t.entryIdx + 70)) }));
    setStartIdx(Math.max(0, t.entryIdx - 30));
    chartTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const st = structures?.[tf];
  const step = Math.max(1, Math.floor(shown / 2));

  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">XAUUSD IRL → ERL backtester</h1>
        <p className="text-sm text-zinc-400">
          Load gold data, set the rules on the left, press <b>Run backtest</b>. Every fill pays spread, slippage and commission;
          orders are only placed from candles that have already closed.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-5 rounded border border-zinc-800 p-3 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Data (UTC)</h2>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">From
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
              </label>
              <label className="text-sm">To
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
              </label>
            </div>
            <button type="button" disabled={status.kind === 'loading'} onClick={() => load('twelvedata')}
              className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50">
              {status.kind === 'loading' && source === 'twelvedata' ? 'Loading… (first load can take a while)' : 'Load gold data (XAU/USD)'}
            </button>
            <button type="button" disabled={status.kind === 'loading'} onClick={() => load('demo')}
              className="w-full rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50">
              {status.kind === 'loading' && source === 'demo' ? 'Loading…' : 'Use demo data (synthetic)'}
            </button>
            <p className="text-xs text-zinc-500">Real data: Twelve Data, 15-minute candles, UTC. Each month is downloaded once, then cached.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Backtest</h2>
            <button type="button" disabled={!data || running || problems.length > 0} onClick={runBacktest}
              className="w-full rounded bg-emerald-700 px-3 py-2 text-sm font-medium hover:bg-emerald-600 disabled:opacity-50">
              {running ? 'Running…' : stale ? 'Run backtest again' : 'Run backtest'}
            </button>
            {!data && <p className="text-xs text-zinc-500">Load data first.</p>}
            {problems.length > 0 && (
              <ul role="alert" className="list-disc pl-4 text-xs text-red-400">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            )}
            {bt.state.status === 'error' && <p role="alert" className="text-xs text-red-400">{bt.state.error}</p>}
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Chart layers</h2>
            {(['swings', 'fvg', 'bos', 'pd', 'trades'] as const).map((k) => (
              <label key={k} className={`flex items-center gap-2 text-sm ${k === 'trades' && !done ? 'opacity-50' : ''}`}>
                <input type="checkbox" checked={layers[k]} disabled={k === 'trades' && !done}
                  onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                {{ swings: 'Swings', fvg: 'FVG zones', bos: 'Break of structure', pd: 'Premium / discount + EQ', trades: 'Trades (entries, exits, SL / TP)' }[k]}
              </label>
            ))}
          </section>

          <ConfigForm config={cfg} onChange={setCfg} liveStage={LIVE_STAGE} />
        </aside>

        <main className="min-w-0">
          {status.kind === 'error' && <ErrorPanel status={status} onDemo={() => load('demo')} />}

          {!data && status.kind !== 'error' && (
            <div className="rounded border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
              Pick a date range and load data to see the detectors and run a backtest.
            </div>
          )}

          {data && structures && candles && (
            <>
              {data.source === 'demo' && (
                <div className="mb-2 rounded border border-orange-600 bg-orange-950/40 px-3 py-2 text-sm">
                  SYNTHETIC DEMO DATA - these are not real prices. Backtest results on it mean nothing; it only shows how the tool behaves.
                </div>
              )}
              <div ref={chartTop} className="mb-2 flex scroll-mt-2 flex-wrap items-center gap-3 text-sm">
                <div className="inline-flex overflow-hidden rounded border border-zinc-700">
                  {(['H1', 'M15'] as const).map((t) => (
                    <button key={t} type="button" onClick={() => { setTf(t); setStartIdx(null); }}
                      className={`px-3 py-1 ${tf === t ? 'bg-zinc-700' : 'hover:bg-zinc-800'}`}>{t}</button>
                  ))}
                </div>
                <label className="flex items-center gap-1">Bars shown
                  <input type="number" min={20} max={2000} value={size[tf]}
                    onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v >= 20 && v <= 2000) setSize({ ...size, [tf]: v }); }}
                    className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5" />
                </label>
                <button type="button" className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
                  onClick={() => setStartIdx(Math.max(0, lo - step))}>◀</button>
                <input type="range" min={0} max={Math.max(0, n - shown)} value={lo} aria-label="Chart window position"
                  onChange={(e) => setStartIdx(Number(e.target.value))} className="w-56" />
                <button type="button" className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
                  onClick={() => setStartIdx(Math.min(n - shown, lo + step))}>▶</button>
                <button type="button" className="text-zinc-400 underline" onClick={() => setStartIdx(null)}>latest</button>
                <span className="text-zinc-400">{candles[lo] && candles[hi - 1] && `${day(candles[lo].time)} → ${day(candles[hi - 1].time)}`}</span>
              </div>

              {figure && <PlotlyChart data={figure.data} layout={figure.layout} />}

              {st && (
                <p className="mt-2 text-sm text-zinc-400">
                  {tf}: {n.toLocaleString()} bars loaded · {st.swings.length} swings · {st.fvgs.length} FVGs · {st.bos.length} BOS.
                  Blue = bullish, orange = bearish. Triangles are confirmed fractal swings. Diamonds are entries, circles partial exits,
                  crosses final exits; green/red lines are winning/losing trades, dashed red = stop, dotted green = final target.
                  Double-click the chart to reset zoom.
                </p>
              )}

              {done && (
                <ResultsPanel result={done.result} metrics={done.metrics} ms={done.ms} stale={stale} running={running}
                  selectedId={selectedId} onSelect={focusTrade} onRerun={runBacktest} finalTpR={done.cfg.finalTpR} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** Plain-language explanation for each error the data route can return. */
const EXPLAIN: Record<string, { title: string; body: string }> = {
  source_not_configured: {
    title: 'Real market data is not set up on this server yet.',
    body: 'The site owner needs to add a Twelve Data API key (TWELVEDATA_API_KEY - see the README). Until then you can explore with demo data.',
  },
  source_auth: {
    title: 'The market-data provider rejected the API key.',
    body: 'The key set on the server is missing, mistyped or revoked. The site owner needs to check TWELVEDATA_API_KEY.',
  },
  source_plan: {
    title: 'The data plan does not include this data.',
    body: 'The provider says the current plan cannot return XAU/USD 15-minute candles. A paid plan (or a different data source) is needed.',
  },
  source_rate_limited: {
    title: 'The data provider is rate-limiting requests.',
    body: 'Wait a minute and try again, or pick a shorter date range. Months already downloaded are cached, so retrying continues where it stopped.',
  },
  source_blocked: {
    title: 'The data feed refused the request.',
    body: 'This provider puts its feed behind a browser bot-check, and this app does not bypass that.',
  },
  range_too_large: { title: 'That date range is too long for this data source.', body: '' },
};

function ErrorPanel({ status, onDemo }: { status: Extract<Status, { kind: 'error' }>; onDemo: () => void }) {
  const e = EXPLAIN[status.code];
  return (
    <div role="alert" className="mb-3 rounded border border-red-700 bg-red-950/40 p-3 text-sm">
      <p className="font-medium">{e?.title ?? 'Could not load candles.'}</p>
      <p className="mt-1 text-zinc-300">{e?.body || status.message}</p>
      {e?.body && <p className="mt-1 text-xs text-zinc-500">Technical detail: {status.message}</p>}
      <button type="button" onClick={onDemo} className="mt-2 rounded bg-zinc-200 px-3 py-1 text-zinc-900 hover:bg-white">
        Use demo data instead
      </button>
    </div>
  );
}
