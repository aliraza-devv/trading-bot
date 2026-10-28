/**
 * backtest.worker.ts - runs the engine off the main thread so the page stays responsive while a
 * backtest crunches. It only wires messages to the engine; all logic lives in packages/engine.
 * (Relative imports on purpose: workers are bundled separately from the app.)
 */
import { runBacktest } from '../packages/engine/backtest';
import { validateConfig } from '../packages/engine/config';
import { computeMetrics } from '../packages/engine/metrics';
import type { WorkerRequest, WorkerResponse } from './protocol';

// `self` is typed for the window in this project, so describe the little of it we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (m: WorkerResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, h1, m15, cfg } = e.data;
  try {
    const problems = validateConfig(cfg);
    if (problems.length) throw new Error(`Invalid settings: ${problems.join('; ')}`);
    const t0 = performance.now();
    const result = runBacktest(h1, m15, cfg);
    const metrics = computeMetrics(result.trades, cfg.startEquity);
    ctx.postMessage({ id, ok: true, result, metrics, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
