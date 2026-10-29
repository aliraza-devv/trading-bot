import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let relayOnce: typeof import('./fileRelay').relayOnce;
let dir: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irl-bridge-data-'));
  process.env.BRIDGE_DATA_DIR = dataDir; // the store reads this when it is first imported: keep the tests out of ./live-data
  ({ relayOnce } = await import('./fileRelay'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irl-bridge-relay-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HEAD = [
  'v=1', 'ea=test', 'symbol=XAUUSD', 'nowUtc=1738800900', 'serverOffsetSec=7200', 'equity=10000.00', 'balance=10000.00',
  'currency=USD', 'demo=1', 'netting=0', 'dryRun=0', 'digits=2', 'point=0.01', 'tickSize=0.01', 'spreadNow=0.30',
];
const request = (...extra: string[]) => [...HEAD, ...extra, 'BAR|1738800000|2900.1|2901.2|2899.5|2900.8|25'].join('\n') + '\n';

describe('shared-folder relay', () => {
  it('answers a request: reads req_*.txt, deletes it, writes resp_*.txt with the wire-format reply', () => {
    fs.writeFileSync(path.join(dir, 'req_1_1.txt'), request());
    expect(relayOnce(dir)).toBe(1);
    expect(fs.existsSync(path.join(dir, 'req_1_1.txt'))).toBe(false);
    const resp = fs.readFileSync(path.join(dir, 'resp_1_1.txt'), 'utf8');
    expect(resp.split('\n')[0]).toBe('OK|1|1738800900|short_history'); // one candle is far too little history, so it declines safely
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]); // no half-written files left behind
  });

  it('a non-demo account is refused and its orders cancelled, through this channel too', () => {
    fs.writeFileSync(path.join(dir, 'req_2_1.txt'), request('ORD|77|BL|0.10|2000.00|1990.00|2020.00|IRL:M1').replace('demo=1', 'demo=0'));
    relayOnce(dir);
    const lines = fs.readFileSync(path.join(dir, 'resp_2_1.txt'), 'utf8').split('\n');
    expect(lines[0]).toBe('OK|1|1738800900|not_demo');
    expect(lines.some((l) => l.startsWith('CANCEL|77|'))).toBe(true);
    expect(lines.some((l) => l.startsWith('PLACE|'))).toBe(false);
  });

  it('a malformed request gets an ERR reply instead of hanging the EA', () => {
    fs.writeFileSync(path.join(dir, 'req_3_1.txt'), 'v=1\nthis is not a request\n');
    expect(relayOnce(dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'resp_3_1.txt'), 'utf8')).toMatch(/^ERR\|/);
  });

  it('ignores files that are not complete requests (a .tmp the EA is still writing) and unrelated files', () => {
    fs.writeFileSync(path.join(dir, 'req_4_1.tmp'), request());
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    expect(relayOnce(dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'req_4_1.tmp'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  it('removes leftovers older than 10 minutes, and only those', () => {
    const old = path.join(dir, 'resp_old_1.txt');
    const fresh = path.join(dir, 'resp_fresh_1.txt');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    relayOnce(dir, Date.now() + 11 * 60_000); // pretend 11 minutes have passed: both look old...
    expect(fs.existsSync(old)).toBe(false);
    fs.writeFileSync(fresh, 'x');
    relayOnce(dir); // ...but at the real time a fresh file stays
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('a folder that does not exist is not an error', () => {
    expect(relayOnce(path.join(dir, 'nope'))).toBe(0);
  });
});
