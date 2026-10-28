/**
 * bridge.ts - the wire format between the MT5 Expert Advisor and this app. Plain text lines, because MQL5
 * has no JSON parser and a hand-rolled one would be a bug farm. Pure functions, no I/O.
 *
 * REQUEST (EA -> app), one record per line, fields separated by "|":
 *   v=1                              header lines are key=value
 *   ea=1.0   symbol=XAUUSD   nowUtc=<epoch seconds>   serverOffsetSec=7200
 *   equity=10000.00   balance=10000.00   currency=USD   demo=1   netting=0   dryRun=0
 *   digits=2   point=0.01   tickSize=0.01   spreadNow=0.30        (spread in PRICE units)
 *   POS|ticket|B or S|volume|openPrice|sl|tp|openUtcSec|comment    our open positions
 *   ORD|ticket|BL or SL|volume|price|sl|tp|comment                 our resting limit orders
 *   EVT|text                                                       what the EA logged since last time
 *   BAR|utcSec|open|high|low|close|spreadPoints                    CLOSED M15 candles, oldest first
 *
 * RESPONSE (app -> EA):
 *   OK|1|<asOfUtcSec>|<status>
 *   NOTE|text
 *   PLACE|B or S|price|sl|tp|riskPct|expiresUtcSec|comment|key
 *   RENEW|ticket|price|sl|tp|expiresUtcSec
 *   CANCEL|ticket|reason
 *   SL|ticket|price
 *   PLAN|ticket|partialPrice|fraction|breakeven
 * Anything the EA does not recognise it ignores. On a malformed request the app answers HTTP 400 "ERR|why".
 */
import type { Candle, Direction } from './types';
import type { LiveDecision, LiveOrder, LivePosition, LiveState } from './live';
import { keyFromComment } from './live';

export interface BridgeMeta {
  eaVersion: string;
  symbol: string;
  digits: number;
  point: number;
  serverOffsetSec: number;
  balance: number;
  currency: string;
  netting: boolean;
  dryRun: boolean;
  /** Median broker spread over the last day of candles, in price units (null if the broker gave none). */
  medianSpread: number | null;
  barCount: number;
  events: string[];
}

export type ParsedRequest =
  | { ok: true; bars: Candle[]; state: Omit<LiveState, 'paused'>; meta: BridgeMeta }
  | { ok: false; error: string };

const MAX_EVENTS = 40;

function num(raw: string | undefined, what: string): number {
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${what} is not a number ("${raw ?? ''}")`);
  return v;
}

const dir = (raw: string | undefined, a: string, b: string, what: string): Direction => {
  if (raw === a) return 1;
  if (raw === b) return -1;
  throw new Error(`${what}: expected ${a} or ${b}, got "${raw ?? ''}"`);
};

export function parseBridgeRequest(text: string): ParsedRequest {
  try {
    const head = new Map<string, string>();
    const bars: Candle[] = [];
    const spreads: number[] = [];
    const positions: LivePosition[] = [];
    const orders: LiveOrder[] = [];
    const events: string[] = [];

    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      const bar = line.startsWith('BAR|');
      if (bar) {
        const p = line.split('|');
        bars.push({
          time: num(p[1], 'BAR time') * 1000, open: num(p[2], 'BAR open'), high: num(p[3], 'BAR high'),
          low: num(p[4], 'BAR low'), close: num(p[5], 'BAR close'), volume: 0,
        });
        spreads.push(p[6] === undefined || p[6] === '' ? 0 : num(p[6], 'BAR spread'));
      } else if (line.startsWith('POS|')) {
        const p = line.split('|');
        const comment = p.slice(8).join('|');
        positions.push({
          ticket: num(p[1], 'POS ticket'), direction: dir(p[2], 'B', 'S', 'POS type'), volume: num(p[3], 'POS volume'),
          openPrice: num(p[4], 'POS price'), sl: num(p[5], 'POS sl'), tp: num(p[6], 'POS tp'),
          openTime: num(p[7], 'POS time') * 1000, key: keyFromComment(comment),
        });
      } else if (line.startsWith('ORD|')) {
        const p = line.split('|');
        const comment = p.slice(7).join('|');
        orders.push({
          ticket: num(p[1], 'ORD ticket'), direction: dir(p[2], 'BL', 'SL', 'ORD type'), volume: num(p[3], 'ORD volume'),
          price: num(p[4], 'ORD price'), sl: num(p[5], 'ORD sl'), tp: num(p[6], 'ORD tp'), key: keyFromComment(comment),
        });
      } else if (line.startsWith('EVT|')) {
        if (events.length < MAX_EVENTS) events.push(line.slice(4).slice(0, 300));
      } else {
        const eq = line.indexOf('=');
        if (eq > 0) head.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }

    if (head.get('v') !== '1') throw new Error(`unsupported protocol version "${head.get('v') ?? ''}" (this app speaks v=1; update the EA file)`);
    const h = (k: string) => head.get(k);
    const point = num(h('point'), 'point');
    if (!(point > 0)) throw new Error('point must be > 0');

    // median spread of the most recent day (96 candles), ignoring candles where the broker gave none
    const recent = spreads.slice(-96).filter((x) => x > 0).sort((a, b) => a - b);
    const medianSpread = recent.length ? recent[Math.floor(recent.length / 2)] * point : null;

    return {
      ok: true,
      bars,
      state: {
        nowMs: num(h('nowUtc'), 'nowUtc') * 1000,
        equity: num(h('equity'), 'equity'),
        spreadNow: Math.max(0, num(h('spreadNow'), 'spreadNow')),
        tickSize: num(h('tickSize'), 'tickSize'),
        demo: h('demo') === '1',
        positions,
        orders,
      },
      meta: {
        eaVersion: h('ea') ?? '?', symbol: h('symbol') ?? '?', digits: Math.max(0, Math.min(8, Math.round(num(h('digits') ?? '2', 'digits')))),
        point, serverOffsetSec: num(h('serverOffsetSec') ?? '0', 'serverOffsetSec'), balance: num(h('balance') ?? h('equity'), 'balance'),
        currency: h('currency') ?? '?', netting: h('netting') === '1', dryRun: h('dryRun') === '1', medianSpread, barCount: bars.length, events,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not read the request' };
  }
}

/** Free text must never contain the field or line separator. */
const clean = (s: string) => s.replace(/[|\r\n]+/g, ' ').slice(0, 200);
const sec = (ms: number) => Math.round(ms / 1000);

export function formatBridgeResponse(d: LiveDecision, digits: number): string {
  const px = (n: number) => n.toFixed(digits);
  const out: string[] = [`OK|1|${sec(d.asOf)}|${d.status}`];
  for (const n of d.notes) out.push(`NOTE|${clean(n)}`);
  for (const a of d.actions) {
    if (a.type === 'place') {
      out.push(`PLACE|${a.direction === 1 ? 'B' : 'S'}|${px(a.price)}|${px(a.sl)}|${px(a.tp)}|${a.riskPct}|${sec(a.expiresMs)}|${clean(a.comment)}|${a.key}`);
    } else if (a.type === 'renew') {
      out.push(`RENEW|${a.ticket}|${px(a.price)}|${px(a.sl)}|${px(a.tp)}|${sec(a.expiresMs)}`);
    } else if (a.type === 'cancel') {
      out.push(`CANCEL|${a.ticket}|${clean(a.reason)}`);
    } else {
      out.push(`SL|${a.ticket}|${px(a.sl)}`);
    }
  }
  for (const p of d.plans) out.push(`PLAN|${p.ticket}|${px(p.partialPrice)}|${p.partialFraction}|${px(p.breakeven)}`);
  return out.join('\n') + '\n';
}
