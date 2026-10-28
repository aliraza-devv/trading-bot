'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Config } from '@engine/config';
import type { WaitingGap } from '@engine/live';
import type { BridgeSnapshot, LogEntry } from '@/lib/bridge/store';
import { SKIP_TEXT } from '@/lib/skipText';

interface Status {
  now: number;
  paused: boolean;
  snapshot: BridgeSnapshot | null;
  log: LogEntry[];
  config: Config;
  customConfig: boolean;
  savedAt: number | null;
}

const BAR_MS = 15 * 60_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const utcMin = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

const STATUS_TEXT: Record<string, string> = {
  ok: 'Normal: watching for setups.',
  paused: 'Paused: no new orders are placed.',
  stale: 'The newest candle is too old (market closed or the feed stalled): no new orders.',
  not_demo: 'This is NOT a demo account: the bridge refuses to trade.',
  bad_data: 'The candle data failed its checks: nothing is traded.',
  short_history: 'Not enough candle history yet: wait for MT5 to download it.',
};

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'idle'; children: React.ReactNode }) {
  const cls = { good: 'bg-emerald-900/60 text-emerald-300', warn: 'bg-amber-900/60 text-amber-300', bad: 'bg-red-900/60 text-red-300', idle: 'bg-zinc-800 text-zinc-300' }[tone];
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function verdictOf(w: WaitingGap): { tone: 'good' | 'warn' | 'idle'; text: string } {
  if (w.verdict === 'order') return { tone: 'good', text: 'Order resting' };
  if (w.verdict === 'nearer_first') return { tone: 'idle', text: 'Waiting behind a nearer gap' };
  if (w.verdict === 'paused') return { tone: 'warn', text: 'Would trade (paused)' };
  return { tone: 'idle', text: w.reason ? SKIP_TEXT[w.reason] : 'Rejected' };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-zinc-800 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      {children}
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3 py-0.5 text-sm"><span className="text-zinc-400">{k}</span><span className="text-right">{v}</span></div>
);

export function LivePanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/bridge/status', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Status;
        if (alive) {
          setSt(j);
          setError(null);
        }
      } catch {
        if (alive) setError('Cannot reach the app. Is it still running?');
      }
    };
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function setPaused(paused: boolean) {
    setBusy(true);
    try {
      const r = await fetch('/api/bridge/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) });
      if (r.ok) setSt((s) => (s ? { ...s, paused } : s));
    } finally {
      setBusy(false);
    }
  }

  const snap = st?.snapshot ?? null;
  const age = st && snap ? st.now - snap.receivedAt : null;
  const connected = age !== null && age <= BAR_MS + 2 * 60_000;
  const cfg = st?.config;

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">MT5 bridge · live monitor</h1>
          <p className="text-sm text-zinc-400">
            Shows what the Expert Advisor in MetaTrader 5 is being told to do. Demo accounts only. <Link href="/" className="underline hover:text-zinc-200">← Back to the backtester</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {st && (st.paused ? <Pill tone="warn">PAUSED</Pill> : <Pill tone="good">ACTIVE</Pill>)}
          <button type="button" disabled={!st || busy} onClick={() => setPaused(!st?.paused)}
            className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${st?.paused ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-red-800 hover:bg-red-700'}`}>
            {st?.paused ? 'Resume trading' : 'Pause new trades'}
          </button>
        </div>
      </header>

      {error && <p role="alert" className="rounded border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">{error}</p>}

      <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
        <b className="text-zinc-300">Safety:</b> the Expert Advisor refuses to run on a real-money account, risk per trade and lot size are capped inside it,
        pending orders expire after one 15-minute candle (so a stopped bridge cannot leave old orders behind), and every position carries a stop at the broker.
        Pausing here cancels resting orders at the next sync; open positions keep their stop and target.
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Connection">
          {!st && <p className="text-sm text-zinc-400">Loading…</p>}
          {st && !snap && (
            <p className="text-sm text-zinc-300">
              Waiting for the Expert Advisor. Nothing has connected since this app started. Follow <code>mt5/README.md</code> to attach it to an XAUUSD chart in MT5.
            </p>
          )}
          {snap && age !== null && (
            <>
              <Row k="Expert Advisor" v={connected ? <Pill tone="good">Connected</Pill> : <Pill tone="warn">No sync for {ago(age)}</Pill>} />
              <Row k="Last sync" v={`${utc(snap.receivedAt)} UTC (${ago(age)} ago)`} />
              <Row k="Next sync expected" v={`${utc(snap.decision.asOf + BAR_MS)} UTC (after the next candle closes)`} />
              <Row k="Account" v={snap.demo ? <Pill tone="good">DEMO</Pill> : <Pill tone="bad">NOT DEMO: bridge refuses</Pill>} />
              <Row k="Equity" v={`${usd(snap.equity)} ${snap.meta.currency}`} />
              <Row k="Symbol" v={`${snap.meta.symbol}${snap.meta.netting ? ' (netting account)' : ''}`} />
              <Row k="EA mode" v={snap.meta.dryRun ? <Pill tone="warn">DRY RUN: logs only, sends no orders</Pill> : 'Live on the demo account'} />
              <Row k="Candles received" v={`${snap.meta.barCount} (newest opened ${utcMin(snap.lastBarOpen)} UTC)`} />
              <Row k="Spread now" v={`$${snap.spreadNow.toFixed(2)}${snap.meta.medianSpread ? ` · median last day $${snap.meta.medianSpread.toFixed(2)}` : ''}`} />
              {cfg && snap.meta.medianSpread !== null && snap.meta.medianSpread > cfg.spread * 1.5 && (
                <p className="mt-1 text-xs text-amber-300">Your broker&apos;s real spread (${snap.meta.medianSpread.toFixed(2)}) is well above the ${cfg.spread.toFixed(2)} the rules assume, so live results will be worse than the backtest.</p>
              )}
            </>
          )}
        </Card>

        <Card title="Rules in force">
          {cfg && (
            <>
              <Row k="Source" v={st?.customConfig ? <>Saved from the backtester{st.savedAt ? ` (${utcMin(st.savedAt)} UTC)` : ''}</> : <Pill tone="warn">Built-in defaults</Pill>} />
              <Row k="Risk per trade" v={`${cfg.riskPct}% of equity (capped again inside the EA)`} />
              <Row k="Gaps traded" v={{ both: 'H1 and M15 (H1 first)', h1: 'H1 only', m15: 'M15 only' }[cfg.poiTimeframes]} />
              <Row k="Trend / zone filters" v={`${cfg.requireTrendAlignment ? 'trend on' : 'trend off'} · ${cfg.requireZone ? 'zone on' : 'zone off'}`} />
              <Row k="Min distance to target" v={`${cfg.minErlR}R`} />
              <Row k="Partial · trail from · final" v={`${Math.round(cfg.partialFraction * 100)}% at ${cfg.partialAtR}R · ${cfg.trailStartR}R · ${cfg.finalTpR}R`} />
              <Row k="Session (UTC)" v={cfg.sessionFilterEnabled ? cfg.sessionWindowsUtc.map(([a, b]) => `${a}-${b}`).join(', ') : 'any time'} />
              <Row k="Max spread" v={`$${cfg.maxSpread.toFixed(2)}`} />
              <p className="mt-2 text-xs text-zinc-500">Change them in the backtester, test them, then press <b>Use these rules for the MT5 bridge</b>. They apply from the next sync.</p>
            </>
          )}
        </Card>
      </div>

      {snap && (
        <Card title="Latest decision">
          <p className="text-sm">
            <Pill tone={snap.decision.status === 'ok' ? 'good' : snap.decision.status === 'paused' ? 'warn' : 'bad'}>{snap.decision.status.toUpperCase()}</Pill>{' '}
            <span className="text-zinc-300">{STATUS_TEXT[snap.decision.status]}</span>
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
            {snap.decision.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
          {snap.decision.actions.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Asked the EA to</h3>
              <ul className="space-y-0.5 text-sm">
                {snap.decision.actions.map((a, i) => (
                  <li key={i} className="text-zinc-300">
                    {a.type === 'place' && <>Place a <b>{a.direction === 1 ? 'buy' : 'sell'} limit</b> at {a.price.toFixed(2)} · stop {a.sl.toFixed(2)} · target {a.tp.toFixed(2)} · risk {a.riskPct}% · gap {a.key}</>}
                    {a.type === 'renew' && <>Keep order #{a.ticket} alive for one more candle (gap {a.key})</>}
                    {a.type === 'cancel' && <>Cancel order #{a.ticket}: {a.reason}</>}
                    {a.type === 'trail' && <>Trail the stop of position #{a.ticket} to {a.sl.toFixed(2)}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {snap.decision.plans.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-sm text-zinc-300">
              {snap.decision.plans.map((p) => (
                <li key={p.ticket}>Position #{p.ticket}: the EA takes {Math.round(p.partialFraction * 100)}% off when the bid reaches {p.partialPrice.toFixed(2)}, then moves the stop to {p.breakeven.toFixed(2)} (breakeven).</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {snap && (
        <Card title={`Gaps being watched (${snap.decision.waiting.length})`}>
          {snap.decision.waiting.length === 0 ? (
            <p className="text-sm text-zinc-400">No untouched fair value gaps right now.</p>
          ) : (
            <div className="max-h-[320px] overflow-auto rounded border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-900 text-left text-zinc-300">
                  <tr><th className="px-2 py-1">Formed (UTC)</th><th className="px-2 py-1">Gap</th><th className="px-2 py-1">Side</th><th className="px-2 py-1">Range</th><th className="px-2 py-1 text-right">Target</th><th className="px-2 py-1">Status</th></tr>
                </thead>
                <tbody>
                  {snap.decision.waiting.map((w) => {
                    const v = verdictOf(w);
                    const minutes = Number(w.key.slice(1));
                    return (
                      <tr key={w.key} className="border-t border-zinc-800">
                        <td className="px-2 py-1 text-zinc-400">{utcMin(minutes * 60_000)}</td>
                        <td className="px-2 py-1">{w.timeframe}</td>
                        <td className="px-2 py-1">{w.direction === 1 ? 'Long' : 'Short'}</td>
                        <td className="px-2 py-1">{w.bottom.toFixed(2)} – {w.top.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right">{w.erl !== null ? w.erl.toFixed(2) : '–'}</td>
                        <td className="px-2 py-1"><Pill tone={v.tone}>{v.text}</Pill></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {snap && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={`Open positions (${snap.positions.length})`}>
            {snap.positions.length === 0 ? <p className="text-sm text-zinc-400">None.</p> : snap.positions.map((p) => (
              <p key={p.ticket} className="text-sm text-zinc-300">#{p.ticket} · {p.direction === 1 ? 'Long' : 'Short'} {p.volume} lots at {p.openPrice.toFixed(2)} · stop {p.sl ? p.sl.toFixed(2) : 'none'} · target {p.tp ? p.tp.toFixed(2) : 'none'}</p>
            ))}
          </Card>
          <Card title={`Resting orders (${snap.orders.length})`}>
            {snap.orders.length === 0 ? <p className="text-sm text-zinc-400">None.</p> : snap.orders.map((o) => (
              <p key={o.ticket} className="text-sm text-zinc-300">#{o.ticket} · {o.direction === 1 ? 'Buy' : 'Sell'} limit {o.volume} lots at {o.price.toFixed(2)} · stop {o.sl ? o.sl.toFixed(2) : 'none'} · target {o.tp ? o.tp.toFixed(2) : 'none'}</p>
            ))}
          </Card>
        </div>
      )}

      <Card title="Activity">
        {!st || st.log.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing yet.</p>
        ) : (
          <ul className="max-h-[320px] space-y-0.5 overflow-auto font-mono text-xs">
            {[...st.log].reverse().map((l, i) => (
              <li key={i} className={l.kind === 'ea' ? 'text-sky-300' : l.kind === 'system' ? 'text-amber-300' : 'text-zinc-300'}>
                <span className="text-zinc-500">{utc(l.t)}</span> [{l.kind === 'ea' ? 'EA' : l.kind === 'system' ? 'you' : 'bridge'}] {l.text}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
