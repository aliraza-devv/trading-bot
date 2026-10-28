import type { SkipReason } from '@engine/types';

/** Plain-language reasons a touched / waiting gap did not become a trade (results page and Live page). */
export const SKIP_TEXT: Record<SkipReason, string> = {
  busy: 'Another trade was already open',
  no_h1_context: 'No H1 candle had closed yet',
  trend: 'H1 trend was against the trade',
  no_range: 'H1 dealing range not defined yet',
  zone: 'Gap in the wrong half of the H1 range (not discount for longs / premium for shorts)',
  no_erl: 'No confirmed external swing on the same leg yet',
  erl_too_close: 'External swing closer than the minimum R',
  session: 'Touched outside the allowed session',
  spread: 'Spread above the maximum at that time',
  size: 'Risk too small or too large to size at the minimum lot',
};
