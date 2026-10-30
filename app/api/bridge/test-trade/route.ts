/** POST /api/bridge/test-trade - the "Test trade" button on the Live page: ask the EA for ONE small demo trade right now. */
import { localOnly } from '@/lib/bridge/guard';
import { relayDir } from '@/lib/bridge/fileRelay';
import { getSnapshot, isPaused, logYou } from '@/lib/bridge/store';
import { whyNoTestTrade, writeTestRequest } from '@/lib/bridge/testTrade';

const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  const now = Date.now();
  const why = whyNoTestTrade(getSnapshot(), isPaused(), now);
  if (why) return json({ ok: false, message: why }, 409);
  const dir = relayDir();
  if (!dir) return json({ ok: false, message: 'The shared folder with MT5 is not available on this computer.' }, 409);
  const r = writeTestRequest(dir, now);
  if (!r.ok) return json({ ok: false, message: r.why }, 409);
  logYou('Test trade requested: the Expert Advisor should place one small demo trade within a few seconds.');
  return json({ ok: true, message: 'Asked the Expert Advisor for one small test trade. Watch the Trade tab in MT5; the Activity list below shows what happened.' });
}
