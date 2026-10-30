/**
 * live.ts - the live counterpart of backtest.ts. Given the CLOSED M15 candles and the broker's state right
 * now, it answers one question: "what should the MT5 bridge do at this moment?"
 *
 * It contains NO trading rules of its own. Every decision calls the same functions the backtest uses
 * (detectAll, evaluateSetup, sortByPriority, trailCandidate), so a setup that qualifies here is exactly one
 * the backtest would have taken. The tests replay a long series bar by bar and check that.
 *
 * HOW THE BACKTEST'S ORDER MODEL BECOMES REAL ORDERS
 *   Backtest: after candle k-1 closes, every waiting gap is a resting limit order; the first touch consumes
 *   the gap and it becomes a trade if it qualifies. Live: after each M15 close we work out which waiting
 *   gaps WOULD qualify if touched during the next candle, and rest a real pending order for the nearest one
 *   in each direction (the one price reaches first). Orders expire after the next candle, so if the bridge
 *   ever stops, stale orders cannot fill later. The next close recomputes everything from scratch, so no
 *   state is kept anywhere: a gap is "waiting" simply because no candle has touched it yet.
 *
 * PRICES. MT5 candles are BID prices (the backtest treats candles as mid). Levels are therefore converted to
 * what the broker triggers on, using the live spread `s`:
 *   buy limit  fills on ASK -> price = gap top + s        (so it fills when the BID touches the gap top)
 *   sell limit fills on BID -> price = gap bottom
 *   long  SL/TP trigger on BID -> as is;   short SL/TP trigger on ASK -> + s
 * so every trigger behaves like a touch of the chart's candle, exactly as in the backtest.
 *
 * TRADE MANAGEMENT. The final target and the initial stop sit at the broker (they act intrabar, even if the
 * bridge is off). The partial at +partialAtR and the move to breakeven need a price watcher, so we hand the
 * EA a PLAN per open position and it acts on every tick. Trailing is candle-close based (as in the backtest)
 * and is decided here.
 */
import { aggregateToH1, dropUnclosed } from './aggregate';
import type { Config } from './config';
import { detectAll } from './detectors';
import { evaluateSetup, sortByPriority, trailCandidate, type Candidate, type Setup } from './strategy';
import { TF_MS, type Candle, type Direction, type FVG, type SkipReason, type Timeframe } from './types';

const M15 = TF_MS.M15;
const H1 = TF_MS.H1;

// ------------------------------------------------------------------------------------ gap identity
/** Stable id of a gap: timeframe letter + the middle candle's open time in minutes, e.g. "H28980000". */
export const gapKey = (tf: Timeframe, fvg: Pick<FVG, 'time'>): string => `${tf === 'H1' ? 'H' : 'M'}${Math.round(fvg.time / 60_000)}`;
export const ORDER_TAG = 'IRL:';
/** The order comment carries the gap id; the position inherits it, which is how we find the plan again. */
export const commentForKey = (key: string): string => ORDER_TAG + key;
export function keyFromComment(comment: string): string {
  const m = /IRL:([HMT]\d+)/.exec(comment);
  return m ? m[1] : '';
}

// ----------------------------------------------------------------------------------------- test trade
/**
 * The Live page's "Test trade" button: ONE small market order right now, to prove the whole path (order, fill, partial,
 * breakeven, trailing, exit) on the demo account without waiting for a gap to be touched. It is not a strategy setup:
 * the direction is the H1 narrative, 1R is a fraction of the M15 ATR, and the position's tag "T<cents>" carries that 1R
 * (a test trade has no gap to look it up from) so that it is managed exactly like any other position.
 */
export const TEST_RISK_ATR = 0.5;
export const TEST_MIN_RISK = 1.5;
export const testKey = (risk: number): string => `T${Math.round(risk * 100)}`;
/** 1R of a test trade from its tag ("T245" = 2.45); 0 for anything else. */
const testRisk = (key: string): number => {
  const m = /^T(\d+)$/.exec(key);
  return m ? Number(m[1]) / 100 : 0;
};

// ------------------------------------------------------------------------------------------- types
export interface LivePosition {
  ticket: number;
  direction: Direction;
  volume: number;
  openPrice: number;
  sl: number; // 0 = none
  tp: number;
  openTime: number; // ms UTC
  key: string; // gap id from the comment, '' if unknown
}

export interface LiveOrder {
  ticket: number;
  direction: Direction;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  key: string;
}

export interface LiveState {
  nowMs: number;
  equity: number;
  /** Current full bid/ask spread in price units (0 if unknown). */
  spreadNow: number;
  tickSize: number;
  /** The account is a DEMO account. Anything else: the bridge refuses to trade. */
  demo: boolean;
  /** The user pressed pause: no new orders (open positions are still looked after). */
  paused: boolean;
  /** The user pressed "Test trade" on the Live page a moment ago: place ONE small market order now (see testKey). */
  testTrade?: boolean;
  /** An extra sync in the middle of a candle (test trade, or fetching the plan of a position just opened), not the usual one at a candle open. */
  midCandle?: boolean;
  positions: LivePosition[];
  orders: LiveOrder[];
}

export interface LiveOptions {
  /** Fewer closed candles than this and structure (trend, ranges) is not trustworthy yet. */
  minBars?: number;
  /** Refuse to act on data older than this (market closed, feed stuck). */
  maxAgeMs?: number;
  /** Extra life of a pending order beyond the end of the next candle. */
  orderGraceMs?: number;
}

export type LiveStatus = 'ok' | 'paused' | 'stale' | 'not_demo' | 'bad_data' | 'short_history';

export type LiveAction =
  | {
      type: 'place'; key: string; timeframe: Timeframe; direction: Direction;
      price: number; sl: number; tp: number; //   broker prices (spread-adjusted, see header)
      level: number; stop: number; risk: number; erl: number; // the same setup on the chart's price scale
      riskPct: number; expiresMs: number; comment: string;
    }
  | { type: 'renew'; ticket: number; key: string; price: number; sl: number; tp: number; expiresMs: number }
  | { type: 'cancel'; ticket: number; reason: string }
  | { type: 'trail'; ticket: number; sl: number }
  /** Test trade only: buy/sell at the market now. Distances (price units) from the fill price, because the app only knows the last closed candle. */
  | { type: 'market'; key: string; direction: Direction; riskDist: number; tpDist: number; riskPct: number; comment: string };

/** What the EA must watch for on an open position (it acts intrabar, between our candle-close decisions). */
export interface PositionPlan {
  ticket: number;
  key: string;
  partialPrice: number; // act when the BID reaches this (chart price scale)
  partialFraction: number;
  breakeven: number; //    stop to set after the partial (broker price)
}

export interface WaitingGap {
  key: string;
  timeframe: Timeframe;
  direction: Direction;
  bottom: number;
  top: number;
  erl: number | null;
  /** order = an order is resting for it; nearer_first = qualifies, but a nearer gap of the same direction goes first. */
  verdict: 'order' | 'nearer_first' | 'paused' | 'skipped';
  reason?: SkipReason;
}

export interface LiveDecision {
  status: LiveStatus;
  /** Close time of the newest closed candle used (0 if none). */
  asOf: number;
  actions: LiveAction[];
  plans: PositionPlan[];
  waiting: WaitingGap[];
  notes: string[];
}

// -------------------------------------------------------------------------------------- data checks
/** Null when the candles are usable; otherwise why not. Cheap, because bad data must never reach the rules. */
export function checkBars(c: Candle[]): string | null {
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    const when = new Date(b.time).toISOString();
    if (![b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0)) return `candle ${when} has a missing or non-positive price`;
    if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) return `candle ${when} has high/low inconsistent with open/close`;
    if (b.time % M15 !== 0) return `candle ${when} is not aligned to 15 minutes (is the broker time offset right?)`;
    if (i > 0 && b.time <= c[i - 1].time) return `candles are not in strictly increasing time order at ${when}`;
  }
  return null;
}

/** First index whose time >= t. */
function lowerBound(c: Candle[], t: number): number {
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Has an H1 gap been left alone? The backtest judges H1 gaps against M15 candles: a gap starts waiting
 * once the H1 candle that completes it has closed, and the first M15 candle that can touch it is the one
 * AFTER the M15 candle closing at that moment (backtest.ts, step 0).
 */
function h1GapUntouched(m15: Candle[], f: FVG): boolean {
  const closing = lowerBound(m15, f.confirmTime - M15); // first candle closing at/after the gap became known
  for (let j = closing + 1; j < m15.length; j++) {
    if (f.direction === 1 ? m15[j].low <= f.top : m15[j].high >= f.bottom) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------ decide
export function decideLive(input: Candle[], st: LiveState, cfg: Config, opts: LiveOptions = {}): LiveDecision {
  const minBars = opts.minBars ?? 600;
  // A sync in the middle of a candle sees a newest closed candle up to one candle older than one at a candle open.
  const maxAgeMs = (opts.maxAgeMs ?? 10 * 60_000) + (st.midCandle || st.testTrade ? M15 : 0);
  const graceMs = opts.orderGraceMs ?? 120_000;
  const notes: string[] = [];

  const m15 = dropUnclosed(input, M15, st.nowMs); // never trust the caller to have left the forming candle out
  const asOf = m15.length ? m15[m15.length - 1].time + M15 : 0;

  /** Refuse to trade: take every resting order off the book and say why. */
  const halt = (status: LiveStatus, why: string): LiveDecision => {
    notes.push(why);
    return { status, asOf, actions: st.orders.map((o) => ({ type: 'cancel' as const, ticket: o.ticket, reason: why })), plans: [], waiting: [], notes };
  };

  if (!st.demo) return halt('not_demo', 'This is not a demo account. The bridge only trades demo accounts, so nothing will be placed.');
  const bad = checkBars(m15);
  if (bad) return halt('bad_data', `Candle data rejected: ${bad}.`);
  if (m15.length < minBars) return halt('short_history', `Only ${m15.length} closed 15-minute candles received; at least ${minBars} are needed before the structure can be trusted.`);
  if (st.nowMs - asOf > maxAgeMs) {
    return halt('stale', `Newest closed candle is ${Math.round((st.nowMs - asOf) / 60_000)} min old (market closed or feed stalled): no new orders.`);
  }

  // ---- structure, exactly as the backtest builds it
  const L = m15.length - 1;
  const last = m15[L];
  const sM15 = detectAll(m15, M15, cfg);
  const h1 = aggregateToH1(m15, asOf);
  const sH1 = detectAll(h1, H1, cfg);
  const hl = h1.length - 1; // last H1 candle closed at this moment (-1 = none)
  const market = { h1: sH1, m15: sM15 };
  const story = hl < 0 ? 0 : cfg.htfBias === 'trend' ? sH1.bars.trend[hl] : sH1.bars.bias[hl]; // the H1 narrative right now

  const tick = st.tickSize > 0 ? st.tickSize : 0.01;
  const s = Math.max(0, st.spreadNow);
  const snap = (p: number) => Math.round(p / tick) * tick;

  // ---- 1) waiting gaps = gaps nothing has touched yet (the first touch consumes a gap, trade or not)
  const maxAgeBars = cfg.fvgMaxAgeBars;
  const cands: Candidate[] = [];
  if (cfg.poiTimeframes !== 'h1') {
    for (const f of sM15.fvgs) {
      if (maxAgeBars > 0 && L - f.confirmIdx >= maxAgeBars) continue; // same expiry rule as the backtest
      if (f.firstTouchIdx === -1) cands.push({ tf: 'M15', fvg: f });
    }
  }
  if (cfg.poiTimeframes !== 'm15') {
    for (const f of sH1.fvgs) {
      if (maxAgeBars > 0 && hl - f.confirmIdx >= maxAgeBars) continue;
      if (h1GapUntouched(m15, f)) cands.push({ tf: 'H1', fvg: f });
    }
  }

  // ---- 2) would each qualify if touched during the next candle?
  const nextBar: Candle = { time: asOf, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 };
  const busy = st.positions.length > 0;
  const waiting: WaitingGap[] = [];
  const good: Array<{ cand: Candidate; setup: Setup; row: WaitingGap }> = [];
  for (const cand of sortByPriority(cands)) {
    const { fvg, tf } = cand;
    const row: WaitingGap = { key: gapKey(tf, fvg), timeframe: tf, direction: fvg.direction, bottom: fvg.bottom, top: fvg.top, erl: null, verdict: 'skipped' };
    waiting.push(row);
    const r = evaluateSetup({ cand, bar: nextBar, k: L + 1, h1IdxPrev: hl, market, equity: st.equity, busy }, cfg);
    if (!r.ok) {
      row.reason = r.reason;
      continue;
    }
    row.erl = r.setup.poi.erl;
    if (s > cfg.maxSpread) { // the backtest only has a modelled spread; live we also see the real one
      row.reason = 'spread';
      continue;
    }
    good.push({ cand, setup: r.setup, row });
  }

  // ---- 3) the nearest qualifying gap per direction is the one price reaches first: that gets the order
  const nearest = new Map<Direction, (typeof good)[number]>();
  for (const g of good) {
    const cur = nearest.get(g.setup.direction);
    const closer = !cur || (g.setup.direction === 1 ? g.setup.level > cur.setup.level : g.setup.level < cur.setup.level);
    if (closer) nearest.set(g.setup.direction, g);
  }

  const expiresMs = asOf + M15 + graceMs;
  const desired = new Map<string, Extract<LiveAction, { type: 'place' }>>();
  for (const g of good) {
    const chosen = nearest.get(g.setup.direction) === g;
    if (!chosen) {
      g.row.verdict = 'nearer_first';
      continue;
    }
    if (st.paused) {
      g.row.verdict = 'paused';
      continue;
    }
    const { setup } = g;
    const d = setup.direction;
    const tpChart = setup.level + d * cfg.finalTpR * setup.risk;
    const price = snap(d === 1 ? setup.level + s : setup.level);
    const sl = snap(d === 1 ? setup.stop : setup.stop + s);
    const tp = snap(d === 1 ? tpChart : tpChart + s);
    const sane = d === 1 ? sl < price && price < tp : tp < price && price < sl;
    if (!sane) {
      g.row.reason = 'size';
      notes.push(`Gap ${g.row.key}: levels do not make sense for the current spread; skipped.`);
      continue;
    }
    g.row.verdict = 'order';
    const key = g.row.key;
    desired.set(key, {
      type: 'place', key, timeframe: setup.timeframe, direction: d, price, sl, tp,
      level: setup.level, stop: setup.stop, risk: setup.risk, erl: setup.poi.erl,
      riskPct: cfg.riskPct, expiresMs, comment: commentForKey(key),
    });
  }

  // ---- 4) reconcile with what is already resting at the broker
  const actions: LiveAction[] = [];
  const kept = new Set<string>();
  for (const o of st.orders) {
    const d = o.key ? desired.get(o.key) : undefined;
    if (d && !kept.has(o.key)) {
      kept.add(o.key);
      actions.push({ type: 'renew', ticket: o.ticket, key: o.key, price: d.price, sl: d.sl, tp: d.tp, expiresMs: d.expiresMs });
    } else {
      const reason = busy ? 'a position is open' : st.paused ? 'paused' : d ? 'duplicate order' : 'setup no longer valid';
      actions.push({ type: 'cancel', ticket: o.ticket, reason });
    }
  }
  for (const [key, d] of desired) if (!kept.has(key)) actions.push(d);

  // ---- 4b) the Live page's test trade: one small market order now, in the direction of the H1 narrative (demo only: every
  //          refusal above has already returned). Whatever was resting is withdrawn first, the test trade replaces it.
  if (st.testTrade) {
    const refusal = st.paused ? 'the bridge is paused' : busy ? 'a position is already open' : story === 0 ? 'there is no H1 narrative to follow yet' : null;
    if (refusal) {
      notes.push(`Test trade refused: ${refusal}.`);
    } else {
      const atr = sM15.bars.atr[L];
      const risk = Math.max(TEST_MIN_RISK, Math.round((Number.isFinite(atr) ? TEST_RISK_ATR * atr : 0) * 100) / 100);
      const d: Direction = story === 1 ? 1 : -1;
      actions.length = 0;
      for (const o of st.orders) actions.push({ type: 'cancel', ticket: o.ticket, reason: 'test trade' });
      actions.push({
        type: 'market', key: testKey(risk), direction: d, riskDist: risk, tpDist: Math.round(cfg.finalTpR * risk * 100) / 100,
        riskPct: cfg.riskPct, comment: commentForKey(testKey(risk)),
      });
      notes.push(`Test trade: ${d === 1 ? 'buy' : 'sell'} at the market now, 1R = ${risk.toFixed(2)}, target ${cfg.finalTpR}R (the H1 narrative is ${d === 1 ? 'bullish' : 'bearish'}).`);
    }
  }

  // ---- 5) open positions: hand the EA its plan, and trail the stop on candle closes
  const plans: PositionPlan[] = [];
  for (const p of st.positions) {
    const fixedRisk = testRisk(p.key); // a test trade has no gap: its tag carries its 1R and its entry is the fill
    const gap = findGap(p.key, sM15.fvgs, sH1.fvgs); // null for a test tag
    if (!gap && !(fixedRisk > 0)) {
      notes.push(`Position ${p.ticket}: its gap ${p.key || '(no tag in the order comment)'} is not in the data window; the broker's stop and target stay as they are.`);
      continue;
    }
    const d = p.direction;
    const level = gap ? (d === 1 ? gap.top : gap.bottom) : p.openPrice;
    const risk = gap ? Math.abs(level - (d === 1 ? gap.bottom - cfg.slBuffer : gap.top + cfg.slBuffer)) : fixedRisk;
    if (!(risk > 0)) continue;
    plans.push({ ticket: p.ticket, key: p.key, partialPrice: level + d * cfg.partialAtR * risk, partialFraction: cfg.partialFraction, breakeven: p.openPrice });

    // trailing switches on once a candle AFTER the entry candle has reached +trailStartR (backtest: manageBar)
    const entryBar = Math.floor(p.openTime / M15) * M15;
    let fav = d === 1 ? -Infinity : Infinity;
    for (let i = L; i >= 0 && m15[i].time > entryBar; i--) fav = d === 1 ? Math.max(fav, m15[i].high) : Math.min(fav, m15[i].low);
    const target = level + d * cfg.trailStartR * risk;
    if (!(d === 1 ? fav >= target : fav <= target)) continue;

    const currentOnChart = p.sl > 0 ? (d === 1 ? p.sl : p.sl - s) : d === 1 ? -Infinity : Infinity;
    const tf = cfg.trailTimeframe;
    const next = trailCandidate(
      { trailing: true, direction: d, entryTime: entryBar, stop: currentOnChart },
      tf === 'H1' ? sH1.swings : sM15.swings, tf === 'H1' ? hl : L, last.close, cfg,
    );
    if (next === null) continue;
    const sl = snap(d === 1 ? next : next + s);
    const tighter = p.sl <= 0 || (d === 1 ? sl - p.sl >= tick - 1e-9 : p.sl - sl >= tick - 1e-9);
    if (tighter) actions.push({ type: 'trail', ticket: p.ticket, sl });
  }

  // ---- 6) a short summary for the human watching the Live page
  const count = (v: WaitingGap['verdict']) => waiting.filter((w) => w.verdict === v).length;
  const skippedBy = new Map<string, number>();
  for (const w of waiting) if (w.verdict === 'skipped' && w.reason) skippedBy.set(w.reason, (skippedBy.get(w.reason) ?? 0) + 1);
  const why = [...skippedBy].map(([r, n]) => `${r} x${n}`).join(', ');
  notes.push(`H1 narrative: ${story === 1 ? 'bullish' : story === -1 ? 'bearish' : 'none yet'}${cfg.requireTrendAlignment ? ' (only gaps in that direction are traded)' : ''}.`);
  notes.push(
    `${waiting.length} gap(s) waiting: ${count('order')} order(s) resting, ${count('nearer_first')} behind a nearer one, ${count('skipped')} rejected${why ? ` (${why})` : ''}.`,
  );
  if (st.paused) notes.push('Paused: no new orders are placed. Open positions are still managed.');
  if (busy) notes.push('A position is open: no new orders until it is closed.');

  return { status: st.paused ? 'paused' : 'ok', asOf, actions, plans, waiting, notes };
}

/** Find the gap named by a key like "H28980000" (timeframe + middle-candle open time in minutes). */
function findGap(key: string, m15: FVG[], h1: FVG[]): FVG | null {
  const m = /^([HM])(\d+)$/.exec(key);
  if (!m) return null;
  const minutes = Number(m[2]);
  return (m[1] === 'H' ? h1 : m15).find((f) => Math.round(f.time / 60_000) === minutes) ?? null;
}
