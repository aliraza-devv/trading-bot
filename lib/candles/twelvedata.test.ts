import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors';
import { createTwelveDataFetcher, parseTimeSeries, twelveDataFromEnv } from './twelvedata';

const M15 = 15 * 60_000;
const T = Date.UTC(2025, 2, 3); // 2025-03-03 00:00 UTC

// Shapes below match what the live API returned (prices as strings, no volume for forex symbols).
const row = (datetime: string, o: string, extra: Record<string, string> = {}) =>
  ({ datetime, open: o, high: '2901.50', low: '2899.80', close: '2900.90', ...extra });
const okBody = (values: unknown[]) => ({ meta: { symbol: 'XAU/USD', interval: '15min' }, values, status: 'ok' });
const errBody = (code: number, message: string) => ({ code, message, status: 'error' });

describe('parseTimeSeries', () => {
  it('converts string prices, reads datetime as UTC, defaults missing volume to 0, sorts ascending', () => {
    const c = parseTimeSeries(okBody([row('2025-03-03 00:15:00', '2900.9', { volume: '12' }), row('2025-03-03 00:00:00', '2900.1')]));
    expect(c).toEqual([
      { time: T, open: 2900.1, high: 2901.5, low: 2899.8, close: 2900.9, volume: 0 },
      { time: T + M15, open: 2900.9, high: 2901.5, low: 2899.8, close: 2900.9, volume: 12 },
    ]);
  });

  it('shifts close-stamped bars back one period', () => {
    expect(parseTimeSeries(okBody([row('2025-03-03 00:15:00', '1')]), 'close')[0].time).toBe(T);
  });

  it('treats "no data" as an empty range, not an error', () => {
    expect(parseTimeSeries(errBody(400, '**start_date** ... No data is available on the specified dates.'))).toEqual([]);
  });

  it.each([
    [401, 'auth'],
    [403, 'plan'],
    [429, 'rate_limited'],
    [500, 'upstream'],
  ])('maps API error %i to "%s"', (code, expected) => {
    try {
      parseTimeSeries(errBody(code, 'boom'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe(expected);
    }
  });

  it('rejects unexpected shapes and unreadable candles', () => {
    expect(() => parseTimeSeries({ status: 'ok' })).toThrow(/no "values"/);
    expect(() => parseTimeSeries(okBody([row('garbage', '1')]))).toThrow(/unreadable/);
  });
});

/** Fetcher wired to a fake network, a fake clock and a recording sleep. */
function harness(responses: Array<[unknown, number?]>, opts: Partial<Parameters<typeof createTwelveDataFetcher>[0]> = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; auth?: string }> = [];
  const queue = [...responses];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const [body, status = 200] = queue.shift() ?? [okBody([]), 200];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  const fetchMonth = createTwelveDataFetcher({
    apiKey: 'SECRET-KEY', fetchImpl, now: () => clock, rateLimitWaitMs: 5,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    ...opts,
  });
  return { fetchMonth, sleeps, calls };
}
const MONTH = [Date.UTC(2025, 2, 1), Date.UTC(2025, 3, 1)] as const;

describe('createTwelveDataFetcher', () => {
  it('sends the key in a header (never in the URL) and the documented parameters', async () => {
    const h = harness([[okBody([row('2025-03-03 00:00:00', '1')])]]);
    const c = await h.fetchMonth(...MONTH);
    expect(c).toHaveLength(1);
    const { url, auth } = h.calls[0];
    expect(auth).toBe('apikey SECRET-KEY');
    expect(url).not.toContain('SECRET-KEY');
    const p = new URL(url).searchParams;
    expect(Object.fromEntries(p)).toMatchObject({
      symbol: 'XAU/USD', interval: '15min', timezone: 'UTC', order: 'asc', outputsize: '5000',
      start_date: '2025-03-01T00:00:00', end_date: '2025-03-31T23:59:59',
    });
  });

  it('fails clearly, without touching the network, when no key is configured', async () => {
    const h = harness([], { apiKey: undefined });
    await expect(h.fetchMonth(...MONTH)).rejects.toMatchObject({ code: 'not_configured' });
    expect(h.calls).toHaveLength(0);
  });

  it('waits out a per-minute rate limit once, then succeeds', async () => {
    const h = harness([
      [errBody(429, 'You have run out of API credits for the current minute. 9 API credits were used.'), 429],
      [okBody([row('2025-03-03 00:00:00', '1')])],
    ]);
    expect(await h.fetchMonth(...MONTH)).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toContain(5); // the retry wait
  });

  it('does not retry a daily limit (it will not clear for hours)', async () => {
    const h = harness([[errBody(429, 'You have run out of API credits for the day.'), 429]]);
    await expect(h.fetchMonth(...MONTH)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(h.calls).toHaveLength(1);
  });

  it('spaces requests to respect the plan limit (8/min -> 7.75s apart)', async () => {
    const h = harness([[okBody([])], [okBody([])], [okBody([])]]);
    await h.fetchMonth(...MONTH);
    await h.fetchMonth(...MONTH);
    await h.fetchMonth(...MONTH);
    expect(h.sleeps).toEqual([7750, 7750]); // first call is immediate
  });

  it('refuses a possibly truncated response (5000 rows)', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(new Date(T + i * M15).toISOString().slice(0, 19).replace('T', ' '), '1'));
    await expect(harness([[okBody(rows)]]).fetchMonth(...MONTH)).rejects.toMatchObject({ code: 'upstream' });
  });

  it('reports a non-JSON answer as an upstream error', async () => {
    await expect(harness([['<html>bad gateway</html>', 502]]).fetchMonth(...MONTH)).rejects.toMatchObject({ code: 'upstream' });
  });
});

describe('twelveDataFromEnv', () => {
  it('uses safe defaults and ignores invalid overrides', () => {
    expect(twelveDataFromEnv({}).maxDays).toBe(180);
    expect(twelveDataFromEnv({ TWELVEDATA_MAX_DAYS: '400' }).maxDays).toBe(400);
    expect(twelveDataFromEnv({ TWELVEDATA_MAX_DAYS: 'lots' }).maxDays).toBe(180);
    expect(twelveDataFromEnv({ TWELVEDATA_MAX_DAYS: '-5' }).maxDays).toBe(180);
  });
});
