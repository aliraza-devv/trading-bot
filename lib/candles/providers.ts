/**
 * providers.ts - the real market-data sources, looked up by the `source` query parameter.
 * (The synthetic "demo" source is handled directly by the route: it has no month cache.)
 *
 * To add a provider: write a `(startMs, endMs) => Promise<Candle[]>` month fetcher that throws
 * ProviderError on failure, then register it here. Cache keys are namespaced by `keyPrefix` so two
 * providers' prices are never mixed.
 */
import { fetchDukascopyMonth } from './dukascopy';
import type { FetchMonth } from './range';
import { twelveDataFromEnv } from './twelvedata';

export type RealSource = 'twelvedata' | 'dukascopy';
export type Source = RealSource | 'demo';
export const DEFAULT_SOURCE: RealSource = 'twelvedata';
export const SOURCES: readonly Source[] = ['twelvedata', 'dukascopy', 'demo'];

export interface ProviderSpec {
  id: RealSource;
  maxDays: number; //     longest range one request may ask for
  concurrency: number; // simultaneous month downloads
  keyPrefix: string; //   cache namespace
  fetchMonth: FetchMonth;
}

// Built once per server process so the Twelve Data rate limiter keeps its state between requests.
let twelveData: ProviderSpec | undefined;

export function getProvider(id: RealSource): ProviderSpec {
  if (id === 'dukascopy') {
    return { id, maxDays: 400, concurrency: 2, keyPrefix: 'dukascopy-xauusd-m15', fetchMonth: fetchDukascopyMonth };
  }
  if (!twelveData) {
    const { fetchMonth, maxDays } = twelveDataFromEnv();
    // One month at a time: the throttle spaces requests to stay inside the plan's per-minute limit.
    twelveData = { id, maxDays, concurrency: 1, keyPrefix: 'twelvedata-xauusd-m15', fetchMonth };
  }
  return twelveData;
}
