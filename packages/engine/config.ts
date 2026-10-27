/**
 * config.ts - the ONE typed config. Every tunable parameter lives here with its default.
 *
 * `CONFIG_FIELDS` describes each parameter (label, group, range, help text) and the settings form
 * in the UI is generated from it - add a field to Config + CONFIG_FIELDS and it shows up in the UI.
 *
 * Prices are in raw price units (XAUUSD: USD per ounce, so 0.30 = 30 cents).
 * Fields marked stage 2 are declared now so nothing needs renaming later, but no code reads them yet.
 */

export type DealingRangeRule = 'last_swing_pair' | 'rolling' | 'bos_leg';
export type FvgEndEvent = 'touch' | 'fill' | 'close';

export interface Config {
  // ---------------------------------------------------------------- structure (stage 1, live)
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
  /** Which event ends an FVG: first wick into it, wick through all of it, or a close beyond it. */
  fvgEndOn: FvgEndEvent;
  /** An untouched FVG expires after this many bars (0 = never). */
  fvgMaxAgeBars: number;

  // ------------------------------------------------------------ execution / risk (stage 2)
  startEquity: number;
  riskPct: number; // % of current equity risked per trade
  contractSize: number; // oz per 1.00 lot
  spread: number; // full bid/ask spread
  maxSpread: number; // skip entries when the spread exceeds this
  slippage: number; // adverse move on every fill
  commissionPerLot: number; // per lot, on EACH fill
  slBuffer: number; // extra distance beyond the FVG edge for the stop
  sessionFilterEnabled: boolean;
  /** "HH:MM" UTC windows in which new entries are allowed. */
  sessionWindowsUtc: Array<[string, string]>;

  // ------------------------------------------------------------ trade management (stage 2)
  partialAtR: number; // close `partialFraction` here and move SL to breakeven
  partialFraction: number;
  trailStartR: number; // from here trail SL to the latest swing
  finalTpR: number; // close the remainder here
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

  startEquity: 10_000,
  riskPct: 1,
  contractSize: 100,
  spread: 0.3,
  maxSpread: 0.6,
  slippage: 0.1,
  commissionPerLot: 3.5,
  slBuffer: 0.5,
  sessionFilterEnabled: true,
  sessionWindowsUtc: [['07:00', '20:00']],

  partialAtR: 1,
  partialFraction: 0.5,
  trailStartR: 2,
  finalTpR: 3,
};

// ---------------------------------------------------------------------------------- form schema
interface FieldBase {
  key: keyof Config;
  label: string;
  group: 'Swings & structure' | 'Fair value gaps' | 'Execution costs' | 'Risk' | 'Trade management' | 'Sessions';
  stage: 1 | 2;
  help: string;
}
export type FieldSpec = FieldBase &
  (
    | { type: 'number'; min?: number; max?: number; step: number }
    | { type: 'boolean' }
    | { type: 'select'; options: ReadonlyArray<{ value: string; label: string }> }
    | { type: 'sessions' }
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
  { key: 'fvgEndOn', label: 'FVG ends on', group: 'Fair value gaps', stage: 1, type: 'select',
    options: [
      { value: 'touch', label: 'First touch' },
      { value: 'fill', label: 'Full fill (wick)' },
      { value: 'close', label: 'Close beyond' },
    ],
    help: 'The event after which the gap is no longer live (all three events are recorded either way).' },
  { key: 'fvgMaxAgeBars', label: 'FVG max age (bars)', group: 'Fair value gaps', stage: 1, type: 'number', min: 0, step: 1,
    help: 'Untouched gaps expire after this many bars (0 = never).' },

  { key: 'spread', label: 'Spread ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Full bid/ask spread.' },
  { key: 'maxSpread', label: 'Max spread ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Skip entries when spread is wider.' },
  { key: 'slippage', label: 'Slippage ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Adverse move on every fill.' },
  { key: 'commissionPerLot', label: 'Commission ($/lot/fill)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.5, help: 'Charged on each fill.' },
  { key: 'slBuffer', label: 'SL buffer ($)', group: 'Execution costs', stage: 2, type: 'number', min: 0, step: 0.05, help: 'Extra distance beyond the FVG edge.' },

  { key: 'startEquity', label: 'Start equity ($)', group: 'Risk', stage: 2, type: 'number', min: 1, step: 100, help: '' },
  { key: 'riskPct', label: 'Risk per trade (%)', group: 'Risk', stage: 2, type: 'number', min: 0.01, max: 100, step: 0.05, help: 'Of current equity.' },
  { key: 'contractSize', label: 'Contract size (oz/lot)', group: 'Risk', stage: 2, type: 'number', min: 1, step: 1, help: '' },

  { key: 'partialAtR', label: 'Partial at (R)', group: 'Trade management', stage: 2, type: 'number', min: 0, step: 0.25, help: 'Close part and move SL to breakeven.' },
  { key: 'partialFraction', label: 'Partial fraction', group: 'Trade management', stage: 2, type: 'number', min: 0, max: 1, step: 0.05, help: '' },
  { key: 'trailStartR', label: 'Trail from (R)', group: 'Trade management', stage: 2, type: 'number', min: 0, step: 0.25, help: 'Trail SL to the latest swing from here.' },
  { key: 'finalTpR', label: 'Final TP (R)', group: 'Trade management', stage: 2, type: 'number', min: 0, step: 0.25, help: 'Close the remainder here.' },

  { key: 'sessionFilterEnabled', label: 'Session filter', group: 'Sessions', stage: 2, type: 'boolean', help: 'Only allow entries inside the windows below.' },
  { key: 'sessionWindowsUtc', label: 'Session windows (UTC)', group: 'Sessions', stage: 2, type: 'sessions', help: 'HH:MM - HH:MM, UTC.' },
];

/** Human-readable problems with a config (empty array = valid). Used by the UI before running. */
export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(c.fractalN) || c.fractalN < 1) errs.push('Fractal N must be a whole number >= 1');
  if (!Number.isInteger(c.atrPeriod) || c.atrPeriod < 1) errs.push('ATR period must be a whole number >= 1');
  if (!Number.isInteger(c.dealingRangeLookback) || c.dealingRangeLookback < 2) errs.push('Rolling lookback must be a whole number >= 2');
  if (!Number.isInteger(c.fvgMaxAgeBars) || c.fvgMaxAgeBars < 0) errs.push('FVG max age must be a whole number >= 0');
  if (!(c.fvgMinSize >= 0)) errs.push('Min FVG size must be >= 0');
  if (!(c.fvgMinAtrMult >= 0)) errs.push('Min FVG size (x ATR) must be >= 0');
  return errs;
}
