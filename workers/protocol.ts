import type { BacktestResult } from '../packages/engine/backtest';
import type { Config } from '../packages/engine/config';
import type { Metrics } from '../packages/engine/metrics';
import type { Candle } from '../packages/engine/types';

/** Messages between the page and backtest.worker.ts. Plain data only (it is copied between threads). */
export interface WorkerRequest {
  id: number;
  h1: Candle[];
  m15: Candle[];
  cfg: Config;
}

export type WorkerResponse =
  | { id: number; ok: true; result: BacktestResult; metrics: Metrics; ms: number }
  | { id: number; ok: false; error: string };
