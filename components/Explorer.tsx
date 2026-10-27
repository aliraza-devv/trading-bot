'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { DEFAULT_CONFIG, type Config } from '@engine/config';
import { detectAll } from '@engine/detectors';
import { TF_MS, type Candle, type Structure, type Timeframe } from '@engine/types';
import { buildFigure, type Layers } from '@/lib/buildFigure';
import { CandleChart } from './CandleChart';
import { ConfigForm } from './ConfigForm';

/** Which stage of the app is live. Stage 2 will raise this and add the Run button + results page. */
const LIVE_STAGE = 1;

type Source = 'dukascopy' | 'demo';
interface Loaded { source: Source; from: string; to: string; m15: Candle[]; h1: Candle[] }
type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; code: string; message: string };

const toCandles = (rows: number[][]): Candle[] =>
  rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function Explorer() {
  const [from, setFrom] = useState('2025-02-03');
  const [to, setTo] = useState('2025-03-28');
  const [source, setSource] = useState<Source>('dukascopy');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [data, setData] = useState<Loaded | null>(null);

  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
  const [tf, setTf] = useState<Timeframe>('H1');
  const [layers, setLayers] = useState<Layers>({ swings: true, fvg: true, bos: true, pd: true });
  const [size, setSize] = useState<Record<Timeframe, number>>({ H1: 300, M15: 500 });
  const [startIdx, setStartIdx] = useState<number | null>(null); // null = show the latest bars

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

  const candles = data ? (tf === 'H1' ? data.h1 : data.m15) : null;
  const n = candles?.length ?? 0;
  const shown = Math.min(size[tf], n);
  const lo = candles ? Math.max(0, Math.min(startIdx ?? n - shown, n - shown)) : 0;
  const hi = lo + shown;

  const figure = useMemo(() => {
    if (!candles || !structures || hi - lo < 3) return null;
    return buildFigure(candles, structures[tf], TF_MS[tf], lo, hi, layers,
      `XAUUSD ${tf} - swings, FVG, BOS, premium/discount`, 760);
  }, [candles, structures, tf, lo, hi, layers]);

  const st = structures?.[tf];
  const step = Math.max(1, Math.floor(shown / 2));

  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">XAUUSD IRL → ERL backtester</h1>
        <p className="text-sm text-zinc-400">
          Stage 1 - detector check. Candles are marked with swings, FVGs, BOS and premium/discount only.
          No strategy and no trades yet.
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
            <button type="button" disabled={status.kind === 'loading'} onClick={() => load('dukascopy')}
              className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50">
              {status.kind === 'loading' && source === 'dukascopy' ? 'Loading…' : 'Load Dukascopy data'}
            </button>
            <button type="button" disabled={status.kind === 'loading'} onClick={() => load('demo')}
              className="w-full rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50">
              {status.kind === 'loading' && source === 'demo' ? 'Loading…' : 'Use demo data (synthetic)'}
            </button>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Chart layers</h2>
            {(['swings', 'fvg', 'bos', 'pd'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                {{ swings: 'Swings', fvg: 'FVG zones', bos: 'Break of structure', pd: 'Premium / discount + EQ' }[k]}
              </label>
            ))}
          </section>

          <ConfigForm config={cfg} onChange={setCfg} liveStage={LIVE_STAGE} />
        </aside>

        <main className="min-w-0">
          {status.kind === 'error' && <ErrorPanel status={status} onDemo={() => load('demo')} />}

          {!data && status.kind !== 'error' && (
            <div className="rounded border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
              Pick a date range and load data to see the detectors on a chart.
            </div>
          )}

          {data && structures && candles && (
            <>
              {data.source === 'demo' && (
                <div className="mb-2 rounded border border-orange-600 bg-orange-950/40 px-3 py-2 text-sm">
                  SYNTHETIC DEMO DATA - these are not real prices. Use it only to check how the detectors behave.
                </div>
              )}
              <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
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

              {figure && <CandleChart data={figure.data} layout={figure.layout} />}

              {st && (
                <p className="mt-2 text-sm text-zinc-400">
                  {tf}: {n.toLocaleString()} bars loaded · {st.swings.length} swings · {st.fvgs.length} FVGs · {st.bos.length} BOS.
                  Blue = bullish, orange = bearish. Triangles are confirmed fractal swings; hover any marker to see when it
                  became known. Dashed lines run from the broken swing to the candle that closed through it. Double-click the
                  chart to reset zoom.
                </p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function ErrorPanel({ status, onDemo }: { status: Extract<Status, { kind: 'error' }>; onDemo: () => void }) {
  const blocked = status.code === 'source_blocked';
  return (
    <div role="alert" className="mb-3 rounded border border-red-700 bg-red-950/40 p-3 text-sm">
      <p className="font-medium">{blocked ? 'The Dukascopy data feed refused the request.' : 'Could not load candles.'}</p>
      <p className="mt-1 text-zinc-300">
        {blocked
          ? 'Dukascopy now puts its candle feed behind a browser bot-check, and this app does not bypass that. '
            + 'You can explore the detectors with synthetic demo data in the meantime.'
          : status.message}
      </p>
      {blocked && <p className="mt-1 text-xs text-zinc-500">Technical detail: {status.message}</p>}
      <button type="button" onClick={onDemo} className="mt-2 rounded bg-zinc-200 px-3 py-1 text-zinc-900 hover:bg-white">
        Use demo data instead
      </button>
    </div>
  );
}
