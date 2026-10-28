/**
 * dukascopy.ts - XAUUSD M15 from Dukascopy via the `dukascopy-node` package.
 *
 * KNOWN ISSUE (checked 2026-10-27): Dukascopy's candle feed now sits behind an AWS WAF "challenge"
 * (HTTP 202 + `x-amzn-waf-action: challenge`). Plain HTTP requests - which is all this server code
 * is allowed to make - are not answered with data. dukascopy-node can try to get past it by
 * launching a headless Chrome (`wafMode: 'auto'`); that is deliberately switched OFF here because it
 * is bot-check circumvention and would not work on typical serverless hosting anyway. When the feed
 * refuses us we surface a clear error instead of returning empty/partial data.
 * Kept as an optional source (`?source=dukascopy`); the default provider is Twelve Data.
 */
import { getHistoricalRates } from 'dukascopy-node';
import type { Candle } from '@engine/types';
import { ProviderError } from './errors';
import type { FetchMonth } from './range';

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
