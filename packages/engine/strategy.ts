/**
 * strategy.ts - ALL trading rules live here. Edit this file (and config.ts) to change the strategy.
 * backtest.ts only walks through time and calls these functions.
 *
 * THE STRATEGY IN ONE PARAGRAPH
 *   A fair value gap (FVG) is the IRL: internal liquidity price tends to come back to. After the gap
 *   forms, price runs on to an external swing high/low (the ERL: external range liquidity). We place a
 *   limit order at the near edge of the gap and take the trade the first time price returns to it,
 *   aiming for that external swing. Longs buy bullish gaps, shorts sell bearish gaps.
 *
 * THE HIGHER TIMEFRAME DECIDES. While the H1 narrative is bearish, the M15 (and H1) bearish gaps are the ones
 * that get respected: we sell the pull-back into them. A bullish gap in a bearish narrative is only a short
 * retracement, so it is never traded (and the other way round). The narrative is steady on purpose (see
 * narrativeBias in detectors.ts): a short move the other way does not turn it. The pull-back itself is rule 6:
 * a short is only taken after price has retraced up into the premium half of the H1 range (longs: discount).
 *
 * SETUP RULES (evaluateSetup) - a touched gap becomes a trade only if ALL hold:
 *   1. No position is open (one trade at a time).                              -> 'busy'
 *   2. The touch candle is inside the session windows (if enabled).            -> 'session'
 *   3. The modelled spread at that time is <= maxSpread.                       -> 'spread'
 *   4. H1 context: an H1 candle has closed.                                    -> 'no_h1_context'
 *   5. requireTrendAlignment: the gap's direction is the H1 narrative
 *      (htfBias 'narrative'), or the last H1 BOS direction (htfBias 'trend').  -> 'trend'
 *   6. requireZone: the gap's midpoint is in discount (long) / premium (short)
 *      of the H1 dealing range (= the retrace has happened).                   -> 'no_range' / 'zone'
 *   7. ERL exists: a CONFIRMED swing after the gap on the SAME leg (highest
 *      swing high for a long, lowest swing low for a short).                   -> 'no_erl'
 *   8. The ERL is at least minErlR x risk away from the entry.                 -> 'erl_too_close'
 *   9. The risk distance is positive and sizes to at least minLot.             -> 'size'
 *   H1 gaps are evaluated before M15 gaps (H1 priority), and every gap gets exactly ONE chance:
 *   the first touch consumes it whether or not it became a trade.
 *
 * ENTRY / STOP
 *   long : limit buy at the gap TOP,    stop = gap BOTTOM - slBuffer
 *   short: limit sell at the gap BOTTOM, stop = gap TOP + slBuffer
 *   1R (risk per unit) = |entry level - stop|.
 *
 * TRADE MANAGEMENT (manageBar)
 *   +partialAtR  : close partialFraction of the position, move the stop to breakeven
 *   +trailStartR : from here the stop trails the latest confirmed swing low (long) / high (short)
 *                  formed after the entry (never loosens)
 *   +finalTpR    : close the rest
 *
 * MODELLING CONVENTIONS (all deliberately pessimistic where candles are ambiguous)
 *   - Candle prices are treated as MID prices. Triggers (touch, stop, targets) are judged on those
 *     prices; spread/2 + slippage is then added against you on EVERY fill (entry, partial, exit).
 *   - Orders are placed at the CLOSE of a candle and can only fill in later candles; every decision
 *     uses data up to the previous close (no lookahead). A gap that opens through a level fills at the open.
 *   - On the entry candle only the stop is checked (we cannot know whether the low or high came first).
 *   - If one candle could hit both the stop and a target, the stop is assumed to hit first. After a
 *     partial, the candle's adverse extreme is assumed to come AFTER it (breakeven can be hit that candle).
 *   - Trailing-stop updates use swings confirmed by the candle's close and apply from the NEXT candle.
 */
import type { Config } from './config';
import type {
  Candle, Direction, Fill, FillReason, FVG, POI, SkipReason, Structure, Swing, Timeframe, Trade,
} from './types';

// ====================================================================== 1. time + cost helpers
const minuteOfDay = (ms: number) => Math.floor(ms / 60_000) % 1440; // UTC minutes since midnight
const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** Is `ms` inside [from, to) (UTC "HH:MM")? Windows may wrap midnight; from == to means the whole day. */
export function inWindow(ms: number, from: string, to: string): boolean {
  const t = minuteOfDay(ms);
  const a = hm(from);
  const b = hm(to);
  if (a === b) return true;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export function sessionAllows(ms: number, cfg: Config): boolean {
  return !cfg.sessionFilterEnabled || cfg.sessionWindowsUtc.some(([a, b]) => inWindow(ms, a, b));
}

/** Modelled full spread at a time: the first matching spreadWindows entry, else the normal spread. */
export function spreadAt(ms: number, cfg: Config): number {
  for (const [a, b, s] of cfg.spreadWindows) if (inWindow(ms, a, b)) return s;
  return cfg.spread;
}

/** You BUY at the ask (mid + half spread) and SELL at the bid (mid - half spread); slippage always hurts. */
export const buyPrice = (mid: number, spread: number, slip: number) => mid + spread / 2 + slip;
export const sellPrice = (mid: number, spread: number, slip: number) => mid - spread / 2 - slip;

// ================================================================================ 2. setups
/** A gap waiting to be touched. */
export interface Candidate {
  tf: Timeframe;
  fvg: FVG;
}

export interface Setup {
  timeframe: Timeframe;
  direction: Direction;
  poi: POI;
  level: number; // limit price (mid scale)
  stop: number; // initial stop (mid scale)
  risk: number; // 1R in price units
  lots: number;
}

export interface MarketView {
  h1: Structure;
  m15: Structure;
}

export interface SetupInput {
  cand: Candidate;
  bar: Candle; // the M15 candle that touched the gap
  k: number; // its index
  h1IdxPrev: number; // last H1 candle closed at the PREVIOUS M15 close (-1 = none)
  market: MarketView;
  equity: number;
  busy: boolean;
}

/** First index in `swings` (sorted by pivot idx) whose pivot is >= idx. */
function firstPivotAtOrAfter(swings: Swing[], idx: number): number {
  let lo = 0;
  let hi = swings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (swings[mid].idx < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * ERL = the external swing of the SAME leg as the gap: the highest confirmed swing high (long) /
 * lowest confirmed swing low (short) whose pivot is at or after the gap's middle candle, and that is
 * confirmed by `tfIdx` (the last closed candle of the gap's own timeframe). Because the gap has not
 * been touched since it formed, everything after it is on its side of the gap.
 */
export function findErl(direction: Direction, fvg: FVG, swings: Swing[], tfIdx: number): Swing | null {
  let best: Swing | null = null;
  for (let i = firstPivotAtOrAfter(swings, fvg.idxMid); i < swings.length; i++) {
    const s = swings[i];
    if (s.confirmIdx > tfIdx) continue; // not known yet (a later pivot can never be confirmed earlier)
    if (direction === 1 ? s.kind !== 'high' || s.price <= fvg.top : s.kind !== 'low' || s.price >= fvg.bottom) continue;
    if (!best || (direction === 1 ? s.price > best.price : s.price < best.price)) best = s;
  }
  return best;
}

/** Lots for the risk budget, rounded DOWN to lotStep. 0 means "cannot size this trade". */
export function sizePosition(equity: number, riskDist: number, cfg: Config): number {
  if (!(equity > 0) || !(riskDist > 0)) return 0;
  const raw = (equity * cfg.riskPct) / 100 / (riskDist * cfg.contractSize);
  const lots = Math.round(Math.floor(raw / cfg.lotStep + 1e-9) * cfg.lotStep * 1e6) / 1e6;
  return lots >= cfg.minLot - 1e-12 ? lots : 0;
}

/** Apply every setup rule (see the header) to a gap that was just touched. */
export function evaluateSetup(inp: SetupInput, cfg: Config): { ok: true; setup: Setup } | { ok: false; reason: SkipReason } {
  const { fvg, tf } = inp.cand;
  const d = fvg.direction;
  const no = (reason: SkipReason) => ({ ok: false as const, reason });

  if (inp.busy) return no('busy'); //                                                       rule 1
  if (!sessionAllows(inp.bar.time, cfg)) return no('session'); //                           rule 2
  if (spreadAt(inp.bar.time, cfg) > cfg.maxSpread) return no('spread'); //                  rule 3

  if (inp.h1IdxPrev < 0) return no('no_h1_context'); //                                     rule 4
  const htf = cfg.htfBias === 'trend' ? inp.market.h1.bars.trend[inp.h1IdxPrev] : inp.market.h1.bars.bias[inp.h1IdxPrev];
  if (cfg.requireTrendAlignment && htf !== d) return no('trend'); //                        rule 5
  if (cfg.requireZone) { //                                                                 rule 6
    const eq = inp.market.h1.bars.eq[inp.h1IdxPrev];
    if (Number.isNaN(eq)) return no('no_range');
    if (d === 1 ? fvg.ce >= eq : fvg.ce <= eq) return no('zone');
  }

  const structure = tf === 'H1' ? inp.market.h1 : inp.market.m15;
  const tfIdx = tf === 'H1' ? inp.h1IdxPrev : inp.k - 1;
  const erl = findErl(d, fvg, structure.swings, tfIdx); //                                  rule 7
  if (!erl) return no('no_erl');

  const level = d === 1 ? fvg.top : fvg.bottom;
  const stop = d === 1 ? fvg.bottom - cfg.slBuffer : fvg.top + cfg.slBuffer;
  const risk = Math.abs(level - stop);
  if (!(risk > 0)) return no('size');
  if (Math.abs(erl.price - level) < cfg.minErlR * risk) return no('erl_too_close'); //      rule 8

  const lots = sizePosition(inp.equity, risk, cfg); //                                      rule 9
  if (lots <= 0) return no('size');

  const poi: POI = {
    timeframe: tf, direction: d, fvgConfirmIdx: fvg.confirmIdx, fvgTime: fvg.time, confirmTime: fvg.confirmTime,
    bottom: fvg.bottom, top: fvg.top, erl: erl.price, erlTime: erl.time,
  };
  return { ok: true, setup: { timeframe: tf, direction: d, poi, level, stop, risk, lots } };
}

/**
 * Priority when several gaps are touched on the same candle: H1 before M15, then the most recently
 * formed first. The first one that qualifies is taken; the rest then see a busy position.
 */
export function sortByPriority(c: Candidate[]): Candidate[] {
  return [...c].sort((a, b) => (a.tf === b.tf ? b.fvg.confirmIdx - a.fvg.confirmIdx : a.tf === 'H1' ? -1 : 1));
}

// ====================================================================== 3. open positions
export interface Position {
  id: number;
  direction: Direction;
  timeframe: Timeframe;
  poi: POI;
  entryIdx: number;
  entryTime: number;
  level: number; //        entry limit (mid scale); targets are measured from here
  initialStop: number;
  stop: number; //         stop in force NOW (moves only up for longs / down for shorts)
  risk: number; //         1R in price units
  lots: number;
  lotsLeft: number;
  entryFill: number; //    actual entry price including spread + slippage
  entryExtreme: number; // the entry candle's best price for us (its high for a long, low for a short)
  partialTaken: boolean;
  trailing: boolean; //    trailing has been switched on (+trailStartR reached)
  fills: Fill[]; //        entry first, then exits
  maxFavorableR: number;
  closed: boolean;
}

const EPS = 1e-9;

/** Fill the entry limit on candle `bar`. A candle that gaps through the level fills at its open. */
export function openPosition(setup: Setup, bar: Candle, barIdx: number, id: number, cfg: Config): Position {
  const d = setup.direction;
  const base = d === 1 ? Math.min(setup.level, bar.open) : Math.max(setup.level, bar.open);
  const spread = spreadAt(bar.time, cfg);
  const entryFill = d === 1 ? buyPrice(base, spread, cfg.slippage) : sellPrice(base, spread, cfg.slippage);
  const commission = setup.lots * cfg.commissionPerLot;
  return {
    id, direction: d, timeframe: setup.timeframe, poi: setup.poi, entryIdx: barIdx, entryTime: bar.time,
    level: setup.level, initialStop: setup.stop, stop: setup.stop, risk: setup.risk,
    lots: setup.lots, lotsLeft: setup.lots, entryFill, entryExtreme: d === 1 ? bar.high : bar.low, partialTaken: false, trailing: false,
    fills: [{ time: bar.time, price: entryFill, lots: setup.lots, reason: 'entry', commission, pnl: 0 }],
    maxFavorableR: 0, closed: false,
  };
}

/** Close `lots` of the position at `base` (mid scale) - costs are added here, against you. */
function closeLots(pos: Position, bar: Candle, base: number, lots: number, reason: FillReason, cfg: Config): void {
  const d = pos.direction;
  const spread = spreadAt(bar.time, cfg);
  const price = d === 1 ? sellPrice(base, spread, cfg.slippage) : buyPrice(base, spread, cfg.slippage);
  pos.fills.push({
    time: bar.time, price, lots, reason, commission: lots * cfg.commissionPerLot,
    pnl: d * (price - pos.entryFill) * cfg.contractSize * lots,
  });
  pos.lotsLeft = Math.max(0, pos.lotsLeft - lots);
  if (pos.lotsLeft <= EPS) {
    pos.lotsLeft = 0;
    pos.closed = true;
  }
}

/**
 * Advance an open position through one CLOSED candle. `isEntryBar` = the candle the entry filled in.
 * Order of events (pessimistic, see the header): stop -> partial/breakeven -> trail switch-on -> final TP.
 */
export function manageBar(pos: Position, bar: Candle, isEntryBar: boolean, cfg: Config): void {
  const d = pos.direction;
  const adverse = d === 1 ? bar.low : bar.high; //     the candle's worst price for us
  const favorable = d === 1 ? bar.high : bar.low; //   the candle's best price for us
  const hits = (extreme: number, level: number) => (d === 1 ? extreme <= level : extreme >= level); // adverse side reached `level`
  const lvl = (r: number) => pos.level + d * r * pos.risk; //                                         price of +r R
  const reached = (r: number) => (d === 1 ? favorable >= lvl(r) : favorable <= lvl(r));
  const worse = (a: number, b: number) => (d === 1 ? Math.min(a, b) : Math.max(a, b)); //             gap through a stop fills worse
  const better = (a: number, b: number) => (d === 1 ? Math.max(a, b) : Math.min(a, b)); //            gap through a target fills better
  // Where a target order fills. A candle that GAPS beyond the level fills at its open (better than the level) -
  // unless the ENTRY candle had already traded through the level: we ignore targets on the entry candle, but a
  // resting order would really have filled there, so the next candle's gap open must not give a better price.
  const targetBase = (r: number) => ((d === 1 ? pos.entryExtreme >= lvl(r) : pos.entryExtreme <= lvl(r)) ? lvl(r) : better(lvl(r), bar.open));

  // 1) STOP - using the stop that was in force when the candle started.
  if (hits(adverse, pos.stop)) {
    const reason: FillReason =
      pos.trailing && (d === 1 ? pos.stop > pos.level : pos.stop < pos.level) ? 'trail' : pos.partialTaken ? 'breakeven' : 'stop';
    closeLots(pos, bar, worse(pos.stop, bar.open), pos.lotsLeft, reason, cfg);
    return;
  }
  if (isEntryBar) return; // entry candle: stop check only

  pos.maxFavorableR = Math.max(pos.maxFavorableR, (d * (favorable - pos.level)) / pos.risk);

  // 2) PARTIAL at +partialAtR, then breakeven.
  if (!pos.partialTaken && reached(cfg.partialAtR)) {
    pos.partialTaken = true;
    const want = Math.floor((pos.lots * cfg.partialFraction) / cfg.lotStep + EPS) * cfg.lotStep;
    const out = Math.min(Math.round(want * 1e6) / 1e6, pos.lotsLeft);
    if (out > EPS) closeLots(pos, bar, targetBase(cfg.partialAtR), out, 'partial', cfg);
    if (pos.closed) return;
    pos.stop = d === 1 ? Math.max(pos.stop, pos.level) : Math.min(pos.stop, pos.level); // breakeven
    if (hits(adverse, pos.stop)) { // pessimistic: assume the adverse extreme came after the partial
      closeLots(pos, bar, worse(pos.level, bar.open), pos.lotsLeft, 'breakeven', cfg);
      return;
    }
  }

  // 3) TRAILING switches on at +trailStartR (the stop itself is moved by trailCandidate at the candle close).
  if (!pos.trailing && reached(cfg.trailStartR)) pos.trailing = true;

  // 4) FINAL TARGET.
  if (reached(cfg.finalTpR)) closeLots(pos, bar, targetBase(cfg.finalTpR), pos.lotsLeft, 'target', cfg);
}

/** Force-close at the candle's close (end of the data). Flagged 'end_of_data' so it is easy to exclude. */
export function closeAtMarket(pos: Position, bar: Candle, cfg: Config): void {
  closeLots(pos, bar, bar.close, pos.lotsLeft, 'end_of_data', cfg);
}

/** First index whose confirmIdx is > limit (swings are ordered by confirmIdx). */
function firstConfirmedAfter(swings: Swing[], limit: number): number {
  let lo = 0;
  let hi = swings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (swings[mid].confirmIdx <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * New stop from the trailing rule, or null. Looks at the MOST RECENT swing that is confirmed by
 * `confirmedUpTo` (index in the swings' own timeframe), of the protective kind (swing LOW for a long,
 * HIGH for a short) and formed at/after the entry. The stop only ever tightens, and must stay on
 * the right side of the last close. Call at the close of a candle; the result applies from the next one.
 */
export function trailCandidate(
  pos: Pick<Position, 'trailing' | 'direction' | 'entryTime' | 'stop'>, // narrow on purpose: live.ts calls this with a real broker position
  swings: Swing[], confirmedUpTo: number, lastClose: number, cfg: Config,
): number | null {
  if (!pos.trailing) return null;
  const kind = pos.direction === 1 ? 'low' : 'high';
  for (let i = firstConfirmedAfter(swings, confirmedUpTo) - 1; i >= 0; i--) {
    const s = swings[i];
    if (s.time < pos.entryTime) return null; // older than this trade (and so is everything before it)
    if (s.kind !== kind) continue;
    const sl = pos.direction === 1 ? s.price - cfg.slBuffer : s.price + cfg.slBuffer;
    const tighter = pos.direction === 1 ? sl > pos.stop : sl < pos.stop;
    const valid = pos.direction === 1 ? sl < lastClose : sl > lastClose;
    return tighter && valid ? sl : null; // only the most recent matching swing counts
  }
  return null;
}

/** Turn a finished position into a Trade record with NET results (after all costs). */
export function toTrade(pos: Position, exitIdx: number, cfg: Config): Trade {
  const exits = pos.fills.slice(1);
  const gross = exits.reduce((a, f) => a + f.pnl, 0);
  const commission = pos.fills.reduce((a, f) => a + f.commission, 0);
  const pnl = gross - commission;
  const riskUsd = pos.risk * cfg.contractSize * pos.lots;
  return {
    id: pos.id, direction: pos.direction, timeframe: pos.timeframe, poi: pos.poi,
    entryIdx: pos.entryIdx, exitIdx, entry: pos.fills[0], exits,
    entryLevel: pos.level, stopLoss: pos.initialStop, riskPerUnit: pos.risk,
    lots: pos.lots, riskUsd, rMultiple: pnl / riskUsd, pnl, commission,
    endedBy: exits[exits.length - 1].reason, maxFavorableR: pos.maxFavorableR,
  };
}
