/**
 * store.ts - month cache shared by every provider: memory first, then a JSON file in the OS temp
 * dir (survives dev-server restarts). Keys carry the provider name (see range.ts), so two
 * providers' prices are never mixed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MonthStore, StoredMonth } from './range';

const DIR = path.join(os.tmpdir(), 'xauusd-backtester-cache');
const memory = new Map<string, StoredMonth>();

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
