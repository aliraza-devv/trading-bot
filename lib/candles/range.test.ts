import { describe, expect, it } from 'vitest';
import type { Candle } from '@engine/types';
import { loadM15Range, monthChunks, type MonthStore, type StoredMonth } from './range';

const M = 15 * 60_000;
const memStore = (): MonthStore & { data: Map<string, StoredMonth> } => {
  const data = new Map<string, StoredMonth>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};
const fake = (calls: Array<[number, number]>) => async (s: number, e: number): Promise<Candle[]> => {
  calls.push([s, e]);
  const out: Candle[] = [];
  for (let t = s; t < e; t += 6 * 3_600_000) out.push({ time: t, open: 1, high: 2, low: 0, close: 1, volume: 1 });
  return out;
};

describe('monthChunks', () => {
  it('splits a range into UTC calendar months', () => {
    const ch = monthChunks(Date.UTC(2025, 0, 20), Date.UTC(2025, 2, 5));
    expect(ch.map((c) => c.key)).toEqual(['xauusd-m15-2025-01', 'xauusd-m15-2025-02', 'xauusd-m15-2025-03']);
    expect(ch[1]).toMatchObject({ start: Date.UTC(2025, 1, 1), end: Date.UTC(2025, 2, 1) });
  });
  it('namespaces cache keys per provider so prices from different sources never mix', () => {
    const a = monthChunks(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2), 'twelvedata-xauusd-m15');
    const b = monthChunks(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2), 'dukascopy-xauusd-m15');
    expect(a[0].key).toBe('twelvedata-xauusd-m15-2025-01');
    expect(a[0].key).not.toBe(b[0].key);
  });
  it('does not include a month that starts exactly at the exclusive end', () => {
    expect(monthChunks(Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1))).toHaveLength(1);
  });
});

describe('loadM15Range', () => {
  const now = Date.UTC(2025, 5, 15, 12);

  it('downloads each month once and trims to the requested window', async () => {
    const calls: Array<[number, number]> = [];
    const store = memStore();
    const from = Date.UTC(2025, 0, 20);
    const to = Date.UTC(2025, 1, 10);
    const r = await loadM15Range(from, to, { fetchMonth: fake(calls), store, nowMs: now });
    expect(calls).toHaveLength(2);
    expect(r.candles.every((c) => c.time >= from && c.time < to)).toBe(true);
    expect(r.candles.length).toBeGreaterThan(0);

    // overlapping second request: January is cached, only March is fetched
    const calls2: Array<[number, number]> = [];
    const r2 = await loadM15Range(Date.UTC(2025, 0, 25), Date.UTC(2025, 2, 10), { fetchMonth: fake(calls2), store, nowMs: now });
    expect(calls2.map(([s]) => new Date(s).getUTCMonth())).toEqual([2]);
    expect(r2.cachedMonths).toHaveLength(2);
  });

  it('never asks for the future and re-fetches the live month after the TTL', async () => {
    const calls: Array<[number, number]> = [];
    const store = memStore();
    const dep = { fetchMonth: fake(calls), store, liveTtlMs: 600_000 };
    await loadM15Range(Date.UTC(2025, 5, 1), Date.UTC(2025, 5, 30), { ...dep, nowMs: now });
    expect(calls[0][1]).toBe(now); // clamped to "now", not end of June
    expect(store.data.get('xauusd-m15-2025-06')?.final).toBe(false);

    await loadM15Range(Date.UTC(2025, 5, 1), Date.UTC(2025, 5, 30), { ...dep, nowMs: now + 60_000 });
    expect(calls).toHaveLength(1); // within TTL -> cached
    await loadM15Range(Date.UTC(2025, 5, 1), Date.UTC(2025, 5, 30), { ...dep, nowMs: now + 700_000 });
    expect(calls).toHaveLength(2); // TTL expired -> fetched again
  });

  it('returns sorted, de-duplicated candles', async () => {
    const dup: Candle = { time: Date.UTC(2025, 0, 2), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const r = await loadM15Range(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 31), {
      fetchMonth: async () => [{ ...dup, time: dup.time + M }, dup, dup], store: memStore(), nowMs: now,
    });
    expect(r.candles.map((c) => c.time)).toEqual([dup.time, dup.time + M]);
  });
});
