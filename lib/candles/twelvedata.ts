/**
 * twelvedata.ts - XAU/USD M15 candles from Twelve Data (https://twelvedata.com/docs#time-series).
 *
 * WHAT WAS VERIFIED (live, with Twelve Data's public "demo" key on EUR/USD, 2026-10-27):
 *   - success: { meta, values: [{ datetime: "YYYY-MM-DD HH:MM:SS", open, high, low, close }], status: "ok" }
 *     prices are STRINGS, and forex-type symbols have NO `volume` field (we use 0)
 *   - failure: { code, message, status: "error" }, with the HTTP status mirroring `code`
 *   - the newest bar is still forming; the route drops unclosed bars (see aggregate.ts)
 *
 * NOT VERIFIED (needs a real key): that XAU/USD 15min is included in your plan. Twelve Data's pages
 * say the free plan covers "major pairs"; gold may need a paid plan. That case surfaces as a
 * `plan` error with a plain explanation instead of failing silently.
 *
 * ASSUMPTION worth checking once: that `datetime` is the bar's OPEN time (standard for intraday).
 * If your data turns out to be close-stamped, set TWELVEDATA_BAR_TIME=close and every bar is
 * shifted back one period - getting this wrong silently shifts all candles (= lookahead).
 *
 * Configuration (environment variables, see .env.example):
 *   TWELVEDATA_API_KEY          required
 *   TWELVEDATA_CREDITS_PER_MIN  your plan's per-minute credit limit (free plan: 8)
 *   TWELVEDATA_MAX_DAYS         longest range one request may ask for (default 180)
 *   TWELVEDATA_BAR_TIME         "open" (default) or "close"
 */
import { TF_MS, type Candle } from '@engine/types';
import { ProviderError } from './errors';
import type { FetchMonth } from './range';

const URL_BASE = 'https://api.twelvedata.com/time_series';
const OUTPUT_SIZE = 5000; // API maximum rows per request; a month of M15 is ~2,100 bars
const SYMBOL = 'XAU/USD';

export type BarTime = 'open' | 'close';

// ------------------------------------------------------------------------------- parsing
function errorFor(code: number | undefined, message: string): ProviderError {
  switch (code) {
    case 401:
      return new ProviderError('auth', `Twelve Data rejected the API key. ${message}`);
    case 403:
      return new ProviderError(
        'plan',
        `Your Twelve Data plan does not include this data (XAU/USD 15-minute may need a paid plan). ${message}`,
      );
    case 429:
      return new ProviderError('rate_limited', message);
    default:
      return new ProviderError('upstream', `Twelve Data error ${code ?? '?'}: ${message}`);
  }
}

/** Turn a decoded time_series response into candles (ascending). Throws ProviderError on API errors. */
export function parseTimeSeries(body: unknown, barTime: BarTime = 'open'): Candle[] {
  const b = body as { status?: string; code?: number; message?: string; values?: unknown } | null;
  if (b && b.status === 'error') {
    const message = String(b.message ?? '');
    if (/no data is available|no data found/i.test(message)) return []; // e.g. a range with no trading
    throw errorFor(b.code, message);
  }
  if (!b || !Array.isArray(b.values)) {
    throw new ProviderError('upstream', 'Unexpected response from Twelve Data (no "values" array).');
  }

  const shift = barTime === 'close' ? TF_MS.M15 : 0;
  const out = (b.values as Array<Record<string, string | undefined>>).map((v): Candle => {
    const time = Date.parse(`${String(v.datetime).replace(' ', 'T')}Z`) - shift; // requested with timezone=UTC
    const candle = {
      time, open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
      volume: Number(v.volume ?? 0) || 0, // forex-type symbols carry no volume
    };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      throw new ProviderError('upstream', `Twelve Data returned an unreadable candle: ${JSON.stringify(v)}`);
    }
    return candle;
  });
  return out.sort((a, c) => a.time - c.time);
}

// ------------------------------------------------------------------------------ fetching
export interface TwelveDataOptions {
  apiKey: string | undefined;
  barTime?: BarTime;
  creditsPerMinute?: number; // one request = one credit
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rateLimitWaitMs?: number; // how long to wait before retrying a per-minute 429 (default 61s)
}

/** Space calls out so a plan's per-minute credit limit is never exceeded. */
function createThrottle(minIntervalMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
  let nextFree = 0;
  return async () => {
    const t = now();
    const start = Math.max(t, nextFree);
    nextFree = start + minIntervalMs; // reserve the slot synchronously so concurrent callers queue up
    if (start > t) await sleep(start - t);
  };
}

const isoSec = (ms: number) => new Date(ms).toISOString().slice(0, 19); // "2025-03-01T00:00:00"

export function createTwelveDataFetcher(opts: TwelveDataOptions): FetchMonth {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const perMin = Math.max(1, opts.creditsPerMinute ?? 8);
  const throttle = createThrottle(Math.ceil(60_000 / perMin) + 250, now, sleep);
  const barTime = opts.barTime ?? 'open';
  const retryWait = opts.rateLimitWaitMs ?? 61_000;

  return async (startMs, endMs) => {
    if (!opts.apiKey) {
      throw new ProviderError('not_configured', 'No Twelve Data API key is set. Set TWELVEDATA_API_KEY on the server (see .env.example).');
    }
    const url = new URL(URL_BASE);
    url.search = new URLSearchParams({
      symbol: SYMBOL, interval: '15min', start_date: isoSec(startMs), end_date: isoSec(endMs - 1000),
      timezone: 'UTC', order: 'asc', outputsize: String(OUTPUT_SIZE), format: 'JSON',
    }).toString();

    for (let attempt = 0; ; attempt++) {
      await throttle();
      // The key travels in a header, never in the URL, so it cannot end up in logs or error messages.
      const res = await doFetch(url, { headers: { Authorization: `apikey ${opts.apiKey}` }, cache: 'no-store' });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError('upstream', `Twelve Data returned a non-JSON response (HTTP ${res.status}).`);
      }
      try {
        const candles = parseTimeSeries(body, barTime);
        if (candles.length >= OUTPUT_SIZE) {
          throw new ProviderError('upstream', `Twelve Data returned ${candles.length} rows, the per-request maximum - the month may be truncated.`);
        }
        return candles;
      } catch (e) {
        // Only the PER-MINUTE limit is worth waiting out (a daily limit will not clear for hours).
        const perMinute = e instanceof ProviderError && e.code === 'rate_limited' && /current minute/i.test(e.message);
        if (perMinute && attempt === 0) {
          await sleep(retryWait);
          continue;
        }
        throw e;
      }
    }
  };
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build the fetcher + limits from environment variables (see the header comment). */
export function twelveDataFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    fetchMonth: createTwelveDataFetcher({
      apiKey: env.TWELVEDATA_API_KEY?.trim() || undefined,
      barTime: env.TWELVEDATA_BAR_TIME === 'close' ? 'close' : 'open',
      creditsPerMinute: positive(env.TWELVEDATA_CREDITS_PER_MIN, 8),
    }),
    maxDays: positive(env.TWELVEDATA_MAX_DAYS, 180),
  };
}
