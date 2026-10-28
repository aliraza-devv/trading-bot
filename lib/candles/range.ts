/**
 * range.ts - load an arbitrary date range of M15 candles out of per-month chunks.
 *
 * Why months: users keep trying overlapping ranges ("Jan-Mar", then "Feb-Apr"). Caching per
 * calendar month means each month is downloaded once. Months that are entirely in the past are
 * cached for good; the month that contains "now" is re-fetched after a short TTL.
 *
 * The month fetcher and the store are injected so this logic is testable without the network.
 */
import type { Candle } from '@engine/types';

export interface StoredMonth {
  at: number; // when it was fetched
  final: boolean; // month was fully in the past at fetch time -> never expires
  candles: Candle[];
}
export interface MonthStore {
  get(key: string): Promise<StoredMonth | undefined>;
  set(key: string, value: StoredMonth): Promise<void>;
}
export type FetchMonth = (startMs: number, endMs: number) => Promise<Candle[]>;

export interface MonthChunk { key: string; start: number; end: number } // [start, end) in UTC

/** UTC calendar months overlapping [fromMs, toMs). `prefix` namespaces the cache keys per provider. */
export function monthChunks(fromMs: number, toMs: number, prefix = 'xauusd-m15'): MonthChunk[] {
  const out: MonthChunk[] = [];
  const f = new Date(fromMs);
  const y = f.getUTCFullYear();
  let m = f.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, m, 1);
    if (start >= toMs) break;
    const end = Date.UTC(y, m + 1, 1);
    out.push({ key: `${prefix}-${y}-${String(m + 1).padStart(2, '0')}`, start, end });
    m++;
  }
  return out;
}

export async function loadM15Range(
  fromMs: number,
  toMs: number,
  deps: {
    fetchMonth: FetchMonth;
    store: MonthStore;
    keyPrefix?: string; // per-provider cache namespace, e.g. "twelvedata-xauusd-m15"
    nowMs?: number;
    liveTtlMs?: number;
    concurrency?: number;
  },
): Promise<{ candles: Candle[]; fetchedMonths: string[]; cachedMonths: string[] }> {
  const now = deps.nowMs ?? Date.now();
  const ttl = deps.liveTtlMs ?? 10 * 60_000;
  const chunks = monthChunks(fromMs, toMs, deps.keyPrefix);
  const results = new Map<string, Candle[]>();
  const fetched: string[] = [];
  const cached: string[] = [];

  const todo: MonthChunk[] = [];
  for (const ch of chunks) {
    const hit = await deps.store.get(ch.key);
    if (hit && (hit.final || now - hit.at < ttl)) {
      results.set(ch.key, hit.candles);
      cached.push(ch.key);
    } else {
      todo.push(ch);
    }
  }

  // Small worker pool: be polite to the upstream server.
  const queue = [...todo];
  const worker = async () => {
    for (let ch = queue.shift(); ch; ch = queue.shift()) {
      const upTo = Math.min(ch.end, now); // never ask for the future
      const candles = upTo > ch.start ? await deps.fetchMonth(ch.start, upTo) : [];
      await deps.store.set(ch.key, { at: now, final: ch.end <= now, candles });
      results.set(ch.key, candles);
      fetched.push(ch.key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 2, queue.length) }, worker));

  const all: Candle[] = [];
  for (const ch of chunks) for (const c of results.get(ch.key) ?? []) if (c.time >= fromMs && c.time < toMs) all.push(c);
  all.sort((a, b) => a.time - b.time);
  const dedup = all.filter((c, i) => i === 0 || c.time !== all[i - 1].time);
  return { candles: dedup, fetchedMonths: fetched, cachedMonths: cached };
}
