/**
 * fileRelay.ts - lets the MT5 Expert Advisor talk to this app WITHOUT any web request.
 *
 * Why: MT5's WebRequest only allows listed domains on the standard web ports, and rejects http://localhost:3001
 * with error 4014 whatever you put in the allowed list. Files have no such rules and need no setup.
 *
 * How: both sides use one shared folder, <AppData>\MetaQuotes\Terminal\Common\Files\irl_bridge (the same path for every
 * MT5 install on this Windows account):
 *   EA  -> writes req_<id>.tmp, then renames it to req_<id>.txt (so we never read a half-written file)
 *   app -> every 500 ms: reads each req_<id>.txt, deletes it, runs the same handler as the HTTP route, writes
 *          resp_<id>.tmp and renames it to resp_<id>.txt
 *   EA  -> sees resp_<id>.txt, reads it, deletes it
 * The text inside is exactly the wire format of packages/engine/bridge.ts. The relay is started once when the server
 * starts (instrumentation.ts). Leftover files older than 10 minutes are removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { handleBridgeRequest } from './handle';

const POLL_MS = 500;
const STALE_MS = 10 * 60_000;
const REQ = /^req_([A-Za-z0-9_]+)\.txt$/;

/** The shared folder, or null where there is no MT5 (anything but Windows). */
export function relayDir(): string | null {
  if (process.env.BRIDGE_FILE_DIR) return process.env.BRIDGE_FILE_DIR;
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'MetaQuotes', 'Terminal', 'Common', 'Files', 'irl_bridge') : null;
}

/** Handle every waiting request once. Returns how many were answered. Exported for the tests. */
export function relayOnce(dir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // folder not there (yet)
  }
  let answered = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const m = REQ.exec(name);
    if (!m) {
      // leftovers of crashed runs: requests, responses and temp files nobody picked up
      if (/^(req|resp)_.*\.(txt|tmp)$/.test(name)) {
        try {
          if (now - fs.statSync(full).mtimeMs > STALE_MS) fs.unlinkSync(full);
        } catch {
          /* already gone */
        }
      }
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
      fs.unlinkSync(full);
    } catch {
      continue; // the EA is still moving it into place, or it vanished: try again next tick
    }
    let body: string;
    try {
      body = handleBridgeRequest(text).body;
    } catch (e) {
      body = `ERR|${e instanceof Error ? e.message : 'internal error'}`.replace(/[\r\n|]+/g, ' ');
    }
    try {
      const tmp = path.join(dir, `resp_${m[1]}.tmp`);
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, path.join(dir, `resp_${m[1]}.txt`));
      answered++;
    } catch {
      /* the EA gave up and cleaned up; nothing to do */
    }
  }
  return answered;
}

/** Start the background loop once per server process (also survives dev-server hot reloads). */
export function startFileRelay(): void {
  const g = globalThis as unknown as { __irlRelay?: ReturnType<typeof setInterval> };
  if (g.__irlRelay) return;
  const dir = relayDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return; // cannot create the folder: the HTTP route still works
  }
  g.__irlRelay = setInterval(() => relayOnce(dir), POLL_MS);
  g.__irlRelay.unref?.(); // never keep the process alive just for this
}
