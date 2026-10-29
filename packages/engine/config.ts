/**
 * config.ts - the ONE typed config. Every tunable parameter lives here with its default.
 *
 * `CONFIG_FIELDS` describes each parameter (label, group, range, help text) and the settings form
 * in the UI is generated from it - add a field to Config + CONFIG_FIELDS and it shows up in the UI.
 *
 * Prices are in raw price units (XAUUSD: USD per ounce, so 0.30 = 30 cents). All times are UTC.
 */

export type DealingRangeRule = 'last_swing_pair' | 'rolling' | 'bos_leg';
export type FvgEndEvent = 'touch' | 'fill' | 'close';
export type PoiTimeframes = 'both' | 'h1' | 'm15';
export type TrailTimeframe = 'M15' | 'H1';
export type HtfBiasRule = 'narrative' | 'trend';

export interface Config {
  // ------------------------------------------------------------------ structure (detectors)
  /** Fractal swing: a swing high needs N lower highs on each side (first of equal highs wins). */
  fractalN: number;
  /** Simple-average ATR period, used by the FVG size filter. */
  atrPeriod: number;
  /** BOS needs a candle CLOSE beyond the swing (true) or just a wick through it (false). */
  bosUseClose: boolean;
  /**
   * Dealing range for equilibrium (EQ) and premium/discount:
   *  last_swing_pair -> [latest confirmed swing low, latest confirmed swing high]
   *  rolling         -> [lowest low, highest high] of the last `dealingRangeLookback` bars
   *  bos_leg         -> the leg made by the latest BOS: its origin to the running extreme since
   */
  dealingRangeRule: DealingRangeRule;
  dealingRangeLookback: number;
  /** FVG is kept only if size >= max(fvgMinSize, fvgMinAtrMult * ATR). */
  fvgMinSize: number;
  fvgMinAtrMult: number;
  /** Which event ends an FVG ON THE CHART: first wick into it, wick through all of it, or a close beyond it. */
  fvgEndOn: FvgEndEvent;
  /** An untouched FVG expires after this many bars (0 = never). Also applies to trading. */
  fvgMaxAgeBars: number;

  // -------------------------------------------------------------------- setup rules (strategy)
  /** Which timeframes' fair value gaps may be traded. When both are on, H1 gaps take priority. */
  poiTimeframes: PoiTimeframes;
  /**
   * Trade only WITH the higher timeframe: longs while the H1 narrative is bullish, shorts while it is bearish.
   * A gap against it is only a retracement and is never traded.
   */
  requireTrendAlignment: boolean;
  /**
   * How the H1 narrative is decided:
   *  narrative -> told by the H1 fair value gaps; it turns only when every live gap on its side has been closed through
   *  trend     -> the direction of the latest H1 break of structure (turns much more often)
   */
  htfBias: HtfBiasRule;
  /** Longs only from gaps in the DISCOUNT of the H1 dealing range, shorts only from PREMIUM gaps (= the retrace happened). */
  requireZone: boolean;
  /** The external swing (ERL) must be at least this many R away, otherwise the setup is skipped. */
  minErlR: number;

  // ------------------------------------------------------------------ execution costs
  spread: number; // normal full bid/ask spread
  /** Time windows with a different spread, e.g. the rollover hour: [from "HH:MM", to "HH:MM", spread]. UTC. */
  spreadWindows: Array<[string, string, number]>;
  maxSpread: number; // skip entries when the spread at that time exceeds this
  slippage: number; // adverse move on EVERY fill
  commissionPerLot: number; // per lot, on EACH fill
  slBuffer: number; // extra distance beyond the FVG edge for the stop (and beyond a trailing swing)

  // ------------------------------------------------------------------------------ risk
  startEquity: number;
  riskPct: number; // % of current equity risked per trade
  contractSize: number; // oz per 1.00 lot
  lotStep: number; // smallest lot increment
  minLot: number; // trades that would need fewer lots are skipped

  // ----------------------------------------------------------------- trade management
  partialAtR: number; // close `partialFraction` here and move the stop to breakeven
  partialFraction: number;
  trailStartR: number; // from here the stop trails the latest swing
  finalTpR: number; // close the remainder here
  trailTimeframe: TrailTimeframe; // whose swings the stop trails

  // ------------------------------------------------------------------------ sessions
  sessionFilterEnabled: boolean;
  /** "HH:MM" UTC windows in which new entries are allowed. */
  sessionWindowsUtc: Array<[string, string]>;
}

export const DEFAULT_CONFIG: Config = {
  fractalN: 2,
  atrPeriod: 14,
  bosUseClose: true,
  dealingRangeRule: 'last_swing_pair',
  dealingRangeLookback: 100,
  fvgMinSize: 0.5,
  fvgMinAtrMult: 0.15,
  fvgEndOn: 'fill',
  fvgMaxAgeBars: 200,

  poiTimeframes: 'both',
  requireTrendAlignment: true,
  htfBias: 'narrative',
  requireZone: true,
  minErlR: 3,

  spread: 0.3,
  spreadWindows: [['21:00', '23:00', 1.0]],
  maxSpread: 0.6,
  slippage: 0.1,
  commissionPerLot: 3.5,
  slBuffer: 0.5,

  startEquity: 10_000,
  riskPct: 1,
  contractSize: 100,
  lotStep: 0.01,
  minLot: 0.01,

  partialAtR: 1,
  partialFraction: 0.5,
  trailStartR: 2,
  finalTpR: 3,
  trailTimeframe: 'M15',

  sessionFilterEnabled: true,
  sessionWindowsUtc: [['07:00', '20:00']],
};

// ---------------------------------------------------------------------------------- form schema
interface FieldBase {
  key: keyof Config;
  label: string;
  group:
    | 'Swings & structure'
    | 'Fair value gaps'
    | 'Setup rules'
    | 'Execution costs'
    | 'Risk'
    | 'Trade management'
    | 'Sessions';
  stage: 1 | 2;
  help: string;
}
export type FieldSpec = FieldBase &
  (
    | { type: 'number'; min?: number; max?: number; step: number }
    | { type: 'boolean' }
    | { type: 'select'; options: ReadonlyArray<{ value: string; label: string }> }
    | { type: 'sessions' } // list of [from, to] windows
    | { type: 'spreadWindows' } // list of [from, to, spread] windows
  );

export const CONFIG_FIELDS: FieldSpec[] = [
  { key: 'fractalN', label: 'Fractal N', group: 'Swings & structure', stage: 1, type: 'number', min: 1, max: 10, step: 1,
    help: 'Bars needed on EACH side of a swing. A swing is only known N bars after its pivot.' },
  { key: 'atrPeriod', label: 'ATR period', group: 'Swings & structure', stage: 1, type: 'number', min: 1, max: 100, step: 1,
    help: 'Used for the relative FVG size filter.' },
  { key: 'bosUseClose', label: 'BOS needs a close', group: 'Swings & structure', stage: 1, type: 'boolean',
    help: 'On: a candle must CLOSE beyond the swing. Off: a wick through it is enough.' },
  { key: 'dealingRangeRule', label: 'Dealing range rule', group: 'Swings & structure', stage: 1, type: 'select',
    options: [
      { value: 'last_swing_pair', label: 'Last swing high + low' },
      { value: 'rolling', label: 'Rolling high/low' },
      { value: 'bos_leg', label: 'Latest BOS leg' },
    ],
    help: 'How the range used for EQ and premium/discount is defined.' },
  { key: 'dealingRangeLookback', label: 'Rolling lookback (bars)', group: 'Swings & structure', stage: 1, type: 'number', min: 2, max: 1000, step: 1,
    help: 'Only used by the "Rolling" rule.' },

  { key: 'fvgMinSize', label: 'Min FVG size ($)', group: 'Fair value gaps', stage: 1, type: 'number', min: 0, step: 0.05,
    help: 'Absolute floor for the gap size, in price units.' },
  { key: 'fvgMinAtrMult', label: 'Min FVG size (x ATR)', group: 'Fair value gaps', stage: 1, type: 'number', min: 0, step: 0.05,
    help: 'Gap must also be at least this multiple of ATR (0 = off).' },
  { key: 'fvgEndOn', label: 'FVG ends on (chart)', group: 'Fair value gaps', stage: 1, type: 'select',
    options: [
      { value: 'touch', label: 'First touch' },
      { value: 'fill', label: 'Full fill (wick)' },
      { value: 'close', label: 'Close beyond' },
    ],
    help: 'When a gap stops being drawn. Trading always uses the FIRST touch.' },
  { key: 'fvgMaxAgeBars', label: 'FVG max age (bars)', group: 'Fair value gaps', stage: 1, type: 'number', min: 0, step: 1,
    help: 'Untouched gaps expire after this many bars (0 = never). Applies to trading too.' },

  { key: 'poiTimeframes', label: 'Trade gaps from', group: 'Setup rules', stage: 2, type: 'select',
    options: [
      { value: 'both', label: 'H1 and M15 (H1 first)' },
      { value: 'h1', label: 'H1 only' },
      { value: 'm15', label: 'M15 only' },
    ],
    help: 'When both are on and both are touched, the H1 gap is taken.' },
  { key: 'requireTrendAlignment', label: 'Trade only with the H1 narrative', group: 'Setup rules', stage: 2, type: 'boolean',
    help: 'Longs only while the higher timeframe is bullish, shorts only while it is bearish. A gap against it is just a retracement and is skipped.' },
  { key: 'htfBias', label: 'How the H1 narrative is decided', group: 'Setup rules', stage: 2, type: 'select',
    options: [
      { value: 'narrative', label: 'H1 gaps (steady)' },
      { value: 'trend', label: 'Last structure break' },
    ],
    help: 'H1 gaps (steady): short counter-moves do not turn it; it stays until every live H1 gap on its side has been closed through. Last structure break: follows the latest H1 BOS and turns often.' },
  { key: 'requireZone', label: 'Require discount / premium', group: 'Setup rules', stage: 2, type: 'boolean',
    help: 'Longs only from gaps below the H1 EQ, shorts only from gaps above it: the trade waits for the retrace into the right half of the range.' },
  { key: 'minErlR', label: 'Min distance to ERL (R)', group: 'Setup rules', stage: 2, type: 'number', min: 0, step: 0.25,
    help: 'Skip the setup if the external swing is closer than this many R. Set it to the final TP so the target is reachable.' },

  { key: 'spread', label: 'Spread ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Normal full bid/ask spread.' },
  { key: 'spreadWindows', label: 'Wider-spread windows (UTC)', group: 'Execution costs', stage: 2, type: 'spreadWindows',
    help: 'Times with a different spread, e.g. the daily rollover. The first matching window wins.' },
  { key: 'maxSpread', label: 'Max spread ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'No new entries while the spread is wider than this.' },
  { key: 'slippage', label: 'Slippage ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Adverse move on every fill.' },
  { key: 'commissionPerLot', label: 'Commission ($/lot/fill)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.5, help: 'Charged on each fill.' },
  { key: 'slBuffer', label: 'SL buffer ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Distance beyond the FVG edge (and beyond a trailing swing).' },

  { key: 'startEquity', label: 'Start equity ($)', group: 'Risk', stage: 2, type: 'number', min: 1, step: 100, help: '' },
  { key: 'riskPct', label: 'Risk per trade (%)', group: 'Risk', stage: 2, type: 'number', min: 0.01, max: 100, step: 0.05, help: 'Of current equity.' },
  { key: 'contractSize', label: 'Contract size (oz/lot)', group: 'Risk', stage: 2, type: 'number', min: 1, step: 1, help: '' },
  { key: 'lotStep', label: 'Lot step', group: 'Risk', stage: 2, type: 'number', min: 0.001, step: 0.01, help: 'Position sizes are rounded down to this.' },
  { key: 'minLot', label: 'Min lot', group: 'Risk', stage: 2, type: 'number', min: 0.001, step: 0.01, help: 'Setups needing fewer lots are skipped.' },

  { key: 'partialAtR', label: 'Partial at (R)', group: 'Trade management', stage: 2, type: 'number', min: 0.05, step: 0.25, help: 'Close part here and move the stop to breakeven.' },
  { key: 'partialFraction', label: 'Partial fraction', group: 'Trade management', stage: 2, type: 'number', min: 0, max: 1, step: 0.05, help: 'Share of the position closed at the partial.' },
  { key: 'trailStartR', label: 'Trail from (R)', group: 'Trade management', stage: 2, type: 'number', min: 0.05, step: 0.25, help: 'From here the stop trails the latest swing.' },
  { key: 'finalTpR', label: 'Final TP (R)', group: 'Trade management', stage: 2, type: 'number', min: 0.05, step: 0.25, help: 'Close the remainder here.' },
  { key: 'trailTimeframe', label: 'Trail swings from', group: 'Trade management', stage: 2, type: 'select',
    options: [{ value: 'M15', label: 'M15 swings' }, { value: 'H1', label: 'H1 swings' }],
    help: 'Whose confirmed swing lows/highs the stop follows.' },

  { key: 'sessionFilterEnabled', label: 'Session filter', group: 'Sessions', stage: 2, type: 'boolean', help: 'Only allow entries inside the windows below.' },
  { key: 'sessionWindowsUtc', label: 'Session windows (UTC)', group: 'Sessions', stage: 2, type: 'sessions', help: 'New entries are only allowed inside these windows.' },
];

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Human-readable problems with a config (empty array = valid). Used by the UI before running. */
export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  const whole = (v: number, min: number, name: string) => {
    if (!Number.isInteger(v) || v < min) errs.push(`${name} must be a whole number >= ${min}`);
  };
  whole(c.fractalN, 1, 'Fractal N');
  whole(c.atrPeriod, 1, 'ATR period');
  whole(c.dealingRangeLookback, 2, 'Rolling lookback');
  whole(c.fvgMaxAgeBars, 0, 'FVG max age');
  if (!(c.fvgMinSize >= 0)) errs.push('Min FVG size must be >= 0');
  if (!(c.fvgMinAtrMult >= 0)) errs.push('Min FVG size (x ATR) must be >= 0');
  if (!(c.minErlR >= 0)) errs.push('Min distance to ERL must be >= 0');

  for (const [k, v] of [['Spread', c.spread], ['Max spread', c.maxSpread], ['Slippage', c.slippage], ['Commission', c.commissionPerLot], ['SL buffer', c.slBuffer]] as const) {
    if (!(v >= 0)) errs.push(`${k} must be >= 0`);
  }
  if (!(c.startEquity > 0)) errs.push('Start equity must be > 0');
  if (!(c.riskPct > 0 && c.riskPct <= 100)) errs.push('Risk per trade must be between 0 and 100 %');
  if (!(c.contractSize > 0)) errs.push('Contract size must be > 0');
  if (!(c.lotStep > 0)) errs.push('Lot step must be > 0');
  if (!(c.minLot > 0)) errs.push('Min lot must be > 0');

  if (!(c.partialAtR > 0)) errs.push('Partial at (R) must be > 0');
  if (!(c.partialFraction >= 0 && c.partialFraction <= 1)) errs.push('Partial fraction must be between 0 and 1');
  if (!(c.trailStartR >= c.partialAtR)) errs.push('Trail-from (R) must be >= partial (R)');
  if (!(c.finalTpR >= c.trailStartR)) errs.push('Final TP (R) must be >= trail-from (R)');

  for (const [a, b] of c.sessionWindowsUtc) if (!HM.test(a) || !HM.test(b)) errs.push(`Session window "${a}"-"${b}" must be HH:MM`);
  for (const [a, b, s] of c.spreadWindows) {
    if (!HM.test(a) || !HM.test(b)) errs.push(`Spread window "${a}"-"${b}" must be HH:MM`);
    if (!(s >= 0)) errs.push('Spread window spread must be >= 0');
  }
  return errs;
}
