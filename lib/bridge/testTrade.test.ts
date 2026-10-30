import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveDecision } from '@engine/live';
import type { BridgeSnapshot } from './store';
import { TEST_REQUEST_FILE, whyNoTestTrade, writeTestRequest } from './testTrade';

const NOW = Date.UTC(2026, 9, 30, 19, 7, 0);
const decision: LiveDecision = { status: 'ok', asOf: NOW - 7 * 60_000, actions: [], plans: [], waiting: [], notes: [] };
const snap = (o: Partial<BridgeSnapshot> = {}): BridgeSnapshot => ({
  receivedAt: NOW - 7 * 60_000, equity: 100_000, demo: true, spreadNow: 0.3, lastBarOpen: NOW - 22 * 60_000, positions: [], orders: [], decision,
  meta: { eaVersion: '1.2', symbol: 'XAUUSD', digits: 2, point: 0.01, serverOffsetSec: 7200, balance: 100_000, currency: 'USD', netting: false, dryRun: false, medianSpread: 0.3, barCount: 3000, events: [] },
  ...o,
});

describe('whyNoTestTrade: only ask when the robot can actually do it', () => {
  it('a healthy, idle, demo robot may', () => {
    expect(whyNoTestTrade(snap(), false, NOW)).toBeNull();
  });
  it.each([
    ['never connected', null, false, /not connected/],
    ['silent for 30 minutes', snap({ receivedAt: NOW - 30 * 60_000 }), false, /silent for 30 minutes/],
    ['not a demo account', snap({ demo: false }), false, /not a demo/],
    ['dry run', snap({ meta: { ...snap().meta, dryRun: true } }), false, /dry-run/],
    ['paused', snap(), true, /paused/],
    ['a position is open', snap({ positions: [{ ticket: 1, direction: -1, volume: 1, openPrice: 1, sl: 2, tp: 0, openTime: 0, key: '' }] }), false, /already open/],
    ['not trading (bad data)', snap({ decision: { ...decision, status: 'bad_data' } }), false, /not trading right now \(bad_data\)/],
    ['market closed (stale, old candle)', snap({ decision: { ...decision, status: 'stale', asOf: NOW - 3 * 3_600_000 } }), false, /180 minutes old: the market looks closed/],
  ])('refuses: %s', (_name, s, paused, msg) => {
    expect(whyNoTestTrade(s, paused, NOW)).toMatch(msg);
  });
  it('a check-in 10+ minutes into a candle is "stale" for the ordinary rule but fine for a test trade', () => {
    expect(whyNoTestTrade(snap({ decision: { ...decision, status: 'stale', asOf: NOW - 12 * 60_000 } }), false, NOW)).toBeNull();
    expect(whyNoTestTrade(snap({ decision: { ...decision, status: 'stale', asOf: NOW - 26 * 60_000 } }), false, NOW)).toMatch(/market looks closed/);
  });
});

describe('writeTestRequest: the note the EA looks for', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irl-test-trade-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the time in UTC seconds, leaves no temp file behind, and refuses a second note while the first is waiting', () => {
    expect(writeTestRequest(dir, NOW)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, TEST_REQUEST_FILE), 'utf8')).toBe(String(NOW / 1000));
    expect(fs.readdirSync(dir)).toEqual([TEST_REQUEST_FILE]);
    const again = writeTestRequest(dir, NOW + 1000);
    expect(again.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, TEST_REQUEST_FILE), 'utf8')).toBe(String(NOW / 1000)); // untouched
  });

  it('works again once the EA has taken the note', () => {
    writeTestRequest(dir, NOW);
    fs.unlinkSync(path.join(dir, TEST_REQUEST_FILE));
    expect(writeTestRequest(dir, NOW + 60_000)).toEqual({ ok: true });
  });

  it('creates the folder if it is missing', () => {
    const nested = path.join(dir, 'a', 'irl_bridge');
    expect(writeTestRequest(nested, NOW)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(nested, TEST_REQUEST_FILE))).toBe(true);
  });
});
