/** GET /api/bridge/status - what the Live page shows: the latest sync, the pause switch, the rules in force, the log. */
import { localOnly } from '@/lib/bridge/guard';
import { getLog, getSnapshot, isPaused, loadLiveConfig } from '@/lib/bridge/store';

export async function GET(request: Request) {
  const blocked = localOnly(request, { allowSameOrigin: true });
  if (blocked) return blocked;
  const { config, custom, savedAt } = loadLiveConfig();
  return Response.json(
    { now: Date.now(), paused: isPaused(), snapshot: getSnapshot(), log: getLog(), config, customConfig: custom, savedAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
