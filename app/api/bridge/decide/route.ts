/**
 * POST /api/bridge/decide - the MT5 Expert Advisor can call this after every closed M15 candle (UseWebRequest mode).
 * Body and reply are plain text lines, see packages/engine/bridge.ts for the format.
 * The default mode does not use this route: the EA talks through a shared folder (lib/bridge/fileRelay.ts), which
 * runs the very same handler (lib/bridge/handle.ts).
 */
import { localOnly } from '@/lib/bridge/guard';
import { handleBridgeRequest, MAX_BODY } from '@/lib/bridge/handle';

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const blocked = localOnly(request);
  if (blocked) return blocked;

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return new Response('ERR|request too large', { status: 413, headers: TEXT });
  const r = handleBridgeRequest(await request.text());
  return new Response(r.body, { status: r.status, headers: TEXT });
}
