/**
 * GET /api/candles?from=YYYY-MM-DD&to=YYYY-MM-DD&source=twelvedata|dukascopy|demo
 *
 * Returns XAUUSD M15 candles for the range (both dates inclusive, UTC) plus H1 candles
 * aggregated from them, as compact [time, open, high, low, close, volume] tuples.
 * Only CLOSED candles are returned (see packages/engine/aggregate.ts).
 * Default source: twelvedata (needs TWELVEDATA_API_KEY on the server).
 */
import { NextRequest, NextResponse } from 'next/server';
import { aggregateToH1, dropUnclosed } from '@engine/aggregate';
import { TF_MS, type Candle } from '@engine/types';
import { demoM15 } from '@/lib/candles/demo';
import { ProviderError, type ProviderErrorCode } from '@/lib/candles/errors';
import { DEFAULT_SOURCE, getProvider, SOURCES, type RealSource, type Source } from '@/lib/candles/providers';
import { loadM15Range } from '@/lib/candles/range';
import { monthStore } from '@/lib/candles/store';

const DAY = 86_400_000;
const DEMO_MAX_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** provider error code -> [HTTP status, error name the UI keys its explanation on] */
const ERROR_MAP: Record<ProviderErrorCode, [number, string]> = {
  not_configured: [503, 'source_not_configured'],
  auth: [502, 'source_auth'],
  plan: [502, 'source_plan'],
  rate_limited: [429, 'source_rate_limited'],
  blocked: [502, 'source_blocked'],
  upstream: [502, 'source_error'],
};

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
  const source = (sp.get('source') ?? DEFAULT_SOURCE) as Source;

  if (fromMs === null || toDay === null) return err(400, 'bad_params', 'from and to must be dates like 2025-03-31');
  if (!SOURCES.includes(source)) return err(400, 'bad_params', `source must be one of: ${SOURCES.join(', ')}`);
  const toMs = toDay + DAY; // `to` is inclusive -> exclusive end at the next midnight
  if (toMs <= fromMs) return err(400, 'bad_params', '"to" must not be before "from"');
  if (fromMs < Date.UTC(2010, 0, 1)) return err(400, 'bad_params', 'XAUUSD data before 2010 is not supported.');

  const provider = source === 'demo' ? null : getProvider(source as RealSource);
  const maxDays = provider?.maxDays ?? DEMO_MAX_DAYS;
  if ((toMs - fromMs) / DAY > maxDays) return err(400, 'range_too_large', `Pick at most ${maxDays} days for this data source.`);

  const asOf = Math.min(toMs, Date.now()); // nothing after this has closed yet
  let raw: Candle[];
  let cache = { fetchedMonths: [] as string[], cachedMonths: [] as string[] };
  try {
    if (!provider) {
      raw = demoM15(fromMs, toMs);
    } else {
      const r = await loadM15Range(fromMs, toMs, {
        fetchMonth: provider.fetchMonth, store: monthStore, keyPrefix: provider.keyPrefix, concurrency: provider.concurrency,
      });
      raw = r.candles;
      cache = { fetchedMonths: r.fetchedMonths, cachedMonths: r.cachedMonths }; // not r itself: it also holds the candles
    }
  } catch (e) {
    if (e instanceof ProviderError) {
      const [status, name] = ERROR_MAP[e.code];
      return err(status, name, e.message);
    }
    return err(500, 'internal', e instanceof Error ? e.message : 'unexpected error');
  }

  const m15 = dropUnclosed(raw, TF_MS.M15, asOf);
  // An empty answer means the source gave us nothing: say so, rather than charting an empty series.
  if (m15.length === 0) return err(502, 'no_data', 'The data source returned no candles for this range.');
  const h1 = aggregateToH1(m15, asOf);

  return NextResponse.json(
    { source, from: sp.get('from'), to: sp.get('to'), m15: m15.map(tuple), h1: h1.map(tuple), cache },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
