/**
 * handle.ts - what happens to one request from the EA, whichever way it arrived (the HTTP route or the shared-folder
 * relay): parse it, ask decideLive() (packages/engine/live.ts), remember it for the Live page, build the reply.
 * No trading logic lives here.
 */
import { formatBridgeResponse, parseBridgeRequest } from '@engine/bridge';
import { decideLive } from '@engine/live';
import { isPaused, loadLiveConfig, recordSync } from './store';

export const MAX_BODY = 4_000_000; // 3000 candles are about 170 KB; this is generous but bounded

export function handleBridgeRequest(text: string): { status: number; body: string } {
  if (text.length > MAX_BODY) return { status: 413, body: 'ERR|request too large' };

  const parsed = parseBridgeRequest(text);
  if (!parsed.ok) return { status: 400, body: `ERR|${parsed.error}` };

  const { config } = loadLiveConfig();
  const decision = decideLive(parsed.bars, { ...parsed.state, paused: isPaused() }, config);

  const lastBar = parsed.bars.length ? parsed.bars[parsed.bars.length - 1].time : 0;
  recordSync({
    receivedAt: Date.now(), meta: parsed.meta, equity: parsed.state.equity, demo: parsed.state.demo, spreadNow: parsed.state.spreadNow,
    lastBarOpen: lastBar, positions: parsed.state.positions, orders: parsed.state.orders, decision,
  });

  return { status: 200, body: formatBridgeResponse(decision, parsed.meta.digits) };
}
