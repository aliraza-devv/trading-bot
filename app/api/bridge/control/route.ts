/** POST /api/bridge/control  {"paused": true|false}  - the pause switch on the Live page. */
import { localOnly } from '@/lib/bridge/guard';
import { isPaused, setPaused } from '@/lib/bridge/store';

export async function POST(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_json', message: 'Send {"paused": true} or {"paused": false}.' }, { status: 400 });
  }
  const paused = (body as { paused?: unknown } | null)?.paused;
  if (typeof paused !== 'boolean') return Response.json({ error: 'bad_params', message: '"paused" must be true or false.' }, { status: 400 });
  setPaused(paused);
  return Response.json({ paused: isPaused() }, { headers: { 'Cache-Control': 'no-store' } });
}
