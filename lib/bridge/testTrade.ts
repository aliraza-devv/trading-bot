/**
 * testTrade.ts - the Live page's "Test trade" button, app side.
 *
 * The EA only talks to the app when a candle opens (every 15 minutes), so to place a test trade at once the app leaves a
 * note in the shared folder: <relay dir>/test_trade.txt holding the time it was written (UTC seconds). The EA looks for it
 * every 2 seconds, deletes it, and does an extra sync that carries "testTrade=1"; decideLive() then answers with ONE
 * market order (live.ts). The EA ignores a note older than 90 seconds, so one left behind while MT5 was closed can never
 * fire later. Nothing here trades: it only asks, and every limit (demo only, lots, risk, one position) is enforced again
 * by decideLive() and by the EA.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeSnapshot } from './store';

export const TEST_REQUEST_FILE = 'test_trade.txt';
/** The EA syncs every candle; a little longer than that and it is treated as switched off. */
const ALIVE_MS = 17 * 60_000;
/** The newest closed candle may be this old before the market counts as closed: decideLive's 10 minutes plus the candle a test trade adds. */
const STALE_MARKET_MS = 25 * 60_000;

/** Why a test trade cannot be requested right now (plain words), or null when it can. */
export function whyNoTestTrade(snap: BridgeSnapshot | null, paused: boolean, now: number): string | null {
  if (!snap) return 'The Expert Advisor has not connected yet. Open MT5 and check the smiley face on the chart.';
  const age = now - snap.receivedAt;
  if (age > ALIVE_MS) return `The Expert Advisor has been silent for ${Math.round(age / 60_000)} minutes. Is MT5 open?`;
  if (!snap.demo) return 'This is not a demo account.';
  if (snap.meta.dryRun) return 'The Expert Advisor is in dry-run mode (it only logs, it sends no orders).';
  if (paused) return 'Trading is paused. Press Resume trading first.';
  if (snap.positions.length > 0) return 'A position is already open. The robot takes one trade at a time.';
  const status = snap.decision.status;
  if (status === 'stale') {
    // an EA that checked in 10+ minutes into a candle is "stale" only for the ordinary rule; the test trade allows a candle more
    const old = now - snap.decision.asOf;
    if (old > STALE_MARKET_MS) return `The newest candle is ${Math.round(old / 60_000)} minutes old: the market looks closed.`;
  } else if (status !== 'ok') {
    return `The robot is not trading right now (${status}).`;
  }
  return null;
}

/** Leave the note for the EA. Written under a temporary name and renamed, so the EA never sees half a file. */
export function writeTestRequest(dir: string, now: number): { ok: true } | { ok: false; why: string } {
  const file = path.join(dir, TEST_REQUEST_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) return { ok: false, why: 'A test trade was just requested; the Expert Advisor has not picked it up yet. Wait a few seconds.' };
    const tmp = path.join(dir, 'test_trade.tmp');
    fs.writeFileSync(tmp, String(Math.floor(now / 1000)));
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `Could not write to the shared folder (${e instanceof Error ? e.message : 'unknown error'}).` };
  }
}
