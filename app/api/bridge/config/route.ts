/**
 * /api/bridge/config - the rules the bridge trades with.
 *   GET     the rules in force (saved from the backtester, or the built-in defaults)
 *   POST    save the rules (a full or partial Config as JSON); invalid rules are refused with the reasons
 *   DELETE  go back to the built-in defaults
 */
import { localOnly } from '@/lib/bridge/guard';
import { coerceConfig, loadLiveConfig, resetLiveConfig, saveLiveConfig } from '@/lib/bridge/store';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  return Response.json(loadLiveConfig(), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_json', message: 'The body must be the rules as JSON.' }, { status: 400 });
  }
  const result = saveLiveConfig(coerceConfig(body));
  if (!result.ok) return Response.json({ error: 'invalid_rules', message: result.errors.join(' '), errors: result.errors }, { status: 400 });
  return Response.json(loadLiveConfig(), { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  resetLiveConfig();
  return Response.json(loadLiveConfig(), { headers: NO_STORE });
}
