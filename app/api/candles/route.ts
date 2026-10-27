/**
 * GET /api/candles?from=YYYY-MM-DD&to=YYYY-MM-DD&source=dukascopy|demo
 *
 * Returns XAUUSD M15 candles for the range (both dates inclusive, UTC) plus H1 candles
 * aggregated from them, as compact [time, open, high, low, close, volume] tuples.
 * Only CLOSED candles are returned (see packages/engine/aggregate.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { aggregateToH1, dropUnclosed } from '@engine/aggregate';
import { TF_MS, type Candle } from '@engine/types';
import { demoM15 } from '@/lib/candles/demo';
import { fetchDukascopyMonth, monthStore, ProviderError } from '@/lib/candles/dukascopy';
import { loadM15Range } from '@/lib/candles/range';

const DAY = 86_400_000;
const MAX_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const err = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });
const tuple = (c: Candle) => [c.time, c.open, c.high, c.low, c.close, c.volume];

function parseDay(s: string | null): number | null {
  if (!s || !DATE_RE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const fromMs = parseDay(sp.get('from'));
  const toDay = parseDay(sp.get('to'));
  const source = sp.get('source') ?? 'dukascopy';

  if (fromMs === null || toDay === null) return err(400, 'bad_params', 'from and to must be dates like 2025-03-31');
  if (source !== 'dukascopy' && source !== 'demo') return err(400, 'bad_params', 'source must be "dukascopy" or "demo"');
  const toMs = toDay + DAY; // `to` is inclusive -> exclusive end at the next midnight
  if (toMs <= fromMs) return err(400, 'bad_params', '"to" must not be before "from"');
  if ((toMs - fromMs) / DAY > MAX_DAYS) return err(400, 'range_too_large', `Pick at most ${MAX_DAYS} days.`);
  if (fromMs < Date.UTC(2010, 0, 1)) return err(400, 'bad_params', 'Dukascopy XAUUSD data starts around 2010.');

  const asOf = Math.min(toMs, Date.now()); // nothing after this has closed yet
  let raw: Candle[];
  let cache = { fetchedMonths: [] as string[], cachedMonths: [] as string[] };
  try {
    if (source === 'demo') {
      raw = demoM15(fromMs, toMs);
    } else {
      const r = await loadM15Range(fromMs, toMs, { fetchMonth: fetchDukascopyMonth, store: monthStore });
      raw = r.candles;
      cache = r;
    }
  } catch (e) {
    if (e instanceof ProviderError) return err(502, e.code === 'blocked' ? 'source_blocked' : 'source_error', e.message);
    return err(500, 'internal', e instanceof Error ? e.message : 'unexpected error');
  }

  const m15 = dropUnclosed(raw, TF_MS.M15, asOf);
  // An empty answer for a range that contains weekdays means the source gave us nothing: say so,
  // rather than letting the UI chart an empty series.
  if (m15.length === 0) return err(502, 'no_data', 'The data source returned no candles for this range.');
  const h1 = aggregateToH1(m15, asOf);

  return NextResponse.json(
    {
      source,
      from: sp.get('from'),
      to: sp.get('to'),
      m15: m15.map(tuple),
      h1: h1.map(tuple),
      cache,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
