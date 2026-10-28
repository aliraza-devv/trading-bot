/**
 * POST /api/bridge/decide - the MT5 Expert Advisor calls this after every closed M15 candle.
 * Body and reply are plain text lines, see packages/engine/bridge.ts for the format.
 * The route holds no trading logic: it parses, asks decideLive() (packages/engine/live.ts), records, replies.
 */
import { formatBridgeResponse, parseBridgeRequest } from '@engine/bridge';
import { decideLive } from '@engine/live';
import { localOnly } from '@/lib/bridge/guard';
import { isPaused, loadLiveConfig, recordSync } from '@/lib/bridge/store';

const MAX_BODY = 4_000_000; // 3000 candles are about 170 KB; this is generous but bounded
const TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const blocked = localOnly(request);
  if (blocked) return blocked;

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return new Response('ERR|request too large', { status: 413, headers: TEXT });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response('ERR|request too large', { status: 413, headers: TEXT });

  const parsed = parseBridgeRequest(text);
  if (!parsed.ok) return new Response(`ERR|${parsed.error}`, { status: 400, headers: TEXT });

  const { config } = loadLiveConfig();
  const decision = decideLive(parsed.bars, { ...parsed.state, paused: isPaused() }, config);

  const lastBar = parsed.bars.length ? parsed.bars[parsed.bars.length - 1].time : 0;
  recordSync({
    receivedAt: Date.now(), meta: parsed.meta, equity: parsed.state.equity, demo: parsed.state.demo, spreadNow: parsed.state.spreadNow,
    lastBarOpen: lastBar, positions: parsed.state.positions, orders: parsed.state.orders, decision,
  });

  return new Response(formatBridgeResponse(decision, parsed.meta.digits), { status: 200, headers: TEXT });
}
