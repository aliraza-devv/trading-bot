import { describe, expect, it } from 'vitest';
import { formatBridgeResponse, parseBridgeRequest } from '../bridge';
import type { LiveDecision } from '../live';

const HEAD = [
  'v=1', 'ea=1.0', 'symbol=XAUUSD', 'nowUtc=1738800900', 'serverOffsetSec=7200', 'equity=10000.50', 'balance=10000.00',
  'currency=USD', 'demo=1', 'netting=0', 'dryRun=0', 'digits=2', 'point=0.01', 'tickSize=0.01', 'spreadNow=0.30',
];
const req = (...extra: string[]) => [...HEAD, ...extra].join('\n') + '\n';

describe('parseBridgeRequest', () => {
  it('reads the header, candles, positions, orders and events', () => {
    const r = parseBridgeRequest(req(
      'BAR|1738800000|2900.10|2901.20|2899.50|2900.80|25',
      'BAR|1738800900|2900.80|2902.00|2900.10|2901.70|31',
      'POS|123|B|0.10|2900.50|2895.00|2915.00|1738800100|IRL:H28980000',
      'ORD|124|SL|0.20|2905.00|2910.00|2890.00|IRL:M28980015',
      'EVT|order 124 placed',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bars).toEqual([
      { time: 1738800000_000, open: 2900.1, high: 2901.2, low: 2899.5, close: 2900.8, volume: 0 },
      { time: 1738800900_000, open: 2900.8, high: 2902, low: 2900.1, close: 2901.7, volume: 0 },
    ]);
    expect(r.state).toMatchObject({ nowMs: 1738800900_000, equity: 10000.5, spreadNow: 0.3, tickSize: 0.01, demo: true });
    expect(r.state.positions).toEqual([{ ticket: 123, direction: 1, volume: 0.1, openPrice: 2900.5, sl: 2895, tp: 2915, openTime: 1738800100_000, key: 'H28980000' }]);
    expect(r.state.orders).toEqual([{ ticket: 124, direction: -1, volume: 0.2, price: 2905, sl: 2910, tp: 2890, key: 'M28980015' }]);
    expect(r.meta).toMatchObject({ symbol: 'XAUUSD', digits: 2, serverOffsetSec: 7200, currency: 'USD', dryRun: false, barCount: 2, events: ['order 124 placed'] });
    expect(r.meta.medianSpread).toBeCloseTo(0.31, 9); // 31 points x 0.01 (median of 25, 31 picks the upper one)
  });

  it('accepts Windows line endings and an empty comment', () => {
    const r = parseBridgeRequest(req('POS|1|S|0.10|2900|2910|2880|1738800100|').replace(/\n/g, '\r\n'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.positions[0]).toMatchObject({ direction: -1, key: '' });
  });

  it('demo is false unless the EA says demo=1', () => {
    const r = parseBridgeRequest(req().replace('demo=1', 'demo=0'));
    expect(r.ok && r.state.demo).toBe(false);
  });

  it.each([
    ['an unsupported protocol version', req().replace('v=1', 'v=2'), /version/],
    ['a missing number', req().replace('equity=10000.50', 'equity='), /equity is not a number/],
    ['a garbled candle', req('BAR|1738800000|abc|1|1|1|0'), /BAR open is not a number/],
    ['a bad position side', req('POS|1|X|0.1|1|1|1|1|'), /POS type/],
    ['a zero point size', req().replace('point=0.01', 'point=0'), /point/],
  ])('rejects %s with a readable message', (_name, text, msg) => {
    const r = parseBridgeRequest(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe('formatBridgeResponse', () => {
  const decision: LiveDecision = {
    status: 'ok', asOf: 1738800900_000,
    notes: ['2 gap(s) waiting|with a bar\nand a newline'],
    actions: [
      { type: 'place', key: 'H28980000', timeframe: 'H1', direction: 1, price: 2901.234, sl: 2895, tp: 2920, level: 2900.9, stop: 2895, risk: 5.9, erl: 2920, riskPct: 1, expiresMs: 1738802100_000, comment: 'IRL:H28980000' },
      { type: 'renew', ticket: 7, key: 'M1', price: 2905, sl: 2910, tp: 2890, expiresMs: 1738802100_000 },
      { type: 'cancel', ticket: 8, reason: 'a position is open' },
      { type: 'trail', ticket: 9, sl: 2899.5 },
    ],
    plans: [{ ticket: 9, key: 'H1', partialPrice: 2906.5, partialFraction: 0.5, breakeven: 2900.5 }],
    waiting: [],
  };

  it('writes one line per instruction, with prices at the broker precision', () => {
    expect(formatBridgeResponse(decision, 2).split('\n')).toEqual([
      'OK|1|1738800900|ok',
      'NOTE|2 gap(s) waiting with a bar and a newline',
      'PLACE|B|2901.23|2895.00|2920.00|1|1738802100|IRL:H28980000|H28980000',
      'RENEW|7|2905.00|2910.00|2890.00|1738802100',
      'CANCEL|8|a position is open',
      'SL|9|2899.50',
      'PLAN|9|2906.50|0.5|2900.50',
      '',
    ]);
  });

  it('free text can never break the line / field format', () => {
    const lines = formatBridgeResponse({ ...decision, notes: ['a|b\r\nc'], actions: [{ type: 'cancel', ticket: 1, reason: 'x|y\nz' }], plans: [] }, 2).split('\n');
    expect(lines).toEqual(['OK|1|1738800900|ok', 'NOTE|a b c', 'CANCEL|1|x y z', '']);
  });

  it('a short is S', () => {
    const d: LiveDecision = { ...decision, notes: [], plans: [], actions: [{ ...(decision.actions[0] as Extract<(typeof decision.actions)[number], { type: 'place' }>), direction: -1 }] };
    expect(formatBridgeResponse(d, 2).split('\n')[1]).toMatch(/^PLACE\|S\|/);
  });
});
