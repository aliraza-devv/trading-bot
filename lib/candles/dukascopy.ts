/**
 * dukascopy.ts - XAUUSD M15 from Dukascopy via the `dukascopy-node` package, one UTC month at a
 * time, with a memory + disk cache (see range.ts for the month logic).
 *
 * KNOWN ISSUE (checked 2026-10-27): Dukascopy's candle feed now sits behind an AWS WAF "challenge"
 * (HTTP 202 + `x-amzn-waf-action: challenge`). Plain HTTP requests - which is all this server code
 * is allowed to make - are not answered with data. dukascopy-node can try to get past it by
 * launching a headless Chrome (`wafMode: 'auto'`); that is deliberately switched OFF here because it
 * is bot-check circumvention and would not work on typical serverless hosting anyway. When the feed
 * refuses us we surface a clear error instead of returning empty/partial data.
 * If Dukascopy lifts the challenge, nothing here needs to change.
 */
import { getHistoricalRates } from 'dukascopy-node';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from '@engine/types';
import type { FetchMonth, MonthStore, StoredMonth } from './range';

export class ProviderError extends Error {
  constructor(public code: 'blocked' | 'upstream', message: string) {
    super(message);
  }
}

export const fetchDukascopyMonth: FetchMonth = async (startMs, endMs) => {
  let rows: number[][];
  try {
    rows = (await getHistoricalRates({
      instrument: 'xauusd',
      dates: { from: new Date(startMs), to: new Date(endMs) },
      timeframe: 'm15',
      priceType: 'bid',
      utcOffset: 0,
      volumes: true,
      format: 'array',
      useCache: false, // we do our own month-level caching
      retryCount: 2,
      wafMode: 'off', // never launch a headless browser to defeat a bot challenge
    })) as unknown as number[][];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code ?? '';
    if (/waf/i.test(code) || /waf|403|challenge/i.test(msg)) {
      throw new ProviderError('blocked', `Dukascopy refused the request (bot-protection challenge). ${msg}`);
    }
    throw new ProviderError('upstream', msg);
  }
  return rows.map((r): Candle => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] ?? 0 }));
};

// ---------------------------------------------------------------------------------- cache
const DIR = path.join(os.tmpdir(), 'xauusd-backtester-cache');
const memory = new Map<string, StoredMonth>();

/** Memory first, then a JSON file in the OS temp dir (survives dev-server restarts). */
export const monthStore: MonthStore = {
  async get(key) {
    const hit = memory.get(key);
    if (hit) return hit;
    try {
      const v = JSON.parse(await fs.readFile(path.join(DIR, `${key}.json`), 'utf8')) as StoredMonth;
      memory.set(key, v);
      return v;
    } catch {
      return undefined;
    }
  },
  async set(key, value) {
    memory.set(key, value);
    try {
      await fs.mkdir(DIR, { recursive: true });
      await fs.writeFile(path.join(DIR, `${key}.json`), JSON.stringify(value));
    } catch {
      /* read-only filesystem (some hosts): the memory cache still works */
    }
  },
};
