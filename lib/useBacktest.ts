'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BacktestResult } from '@engine/backtest';
import type { Config } from '@engine/config';
import type { Metrics } from '@engine/metrics';
import type { Candle } from '@engine/types';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol';

export type BacktestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; error: string }
  | { status: 'done'; result: BacktestResult; metrics: Metrics; ms: number; cfg: Config; data: unknown };

/**
 * Runs a backtest in a Web Worker. Starting a new run cancels the one in flight. `data` is whatever
 * object identifies the candles used (kept so the page can tell when a result has gone stale).
 */
export function useBacktest() {
  const [state, setState] = useState<BacktestState>({ status: 'idle' });
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);

  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
  }, []);

  const run = useCallback((h1: Candle[], m15: Candle[], cfg: Config, data: unknown) => {
    stop();
    const id = ++runId.current;
    setState({ status: 'running' });
    const w = new Worker(new URL('../workers/backtest.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id !== id) return;
      if (e.data.ok) setState({ status: 'done', result: e.data.result, metrics: e.data.metrics, ms: e.data.ms, cfg, data });
      else setState({ status: 'error', error: e.data.error });
      w.terminate();
      if (worker.current === w) worker.current = null;
    };
    w.onerror = (e) => {
      if (id === runId.current) setState({ status: 'error', error: e.message || 'The backtest worker crashed.' });
    };
    const msg: WorkerRequest = { id, h1, m15, cfg };
    w.postMessage(msg);
  }, [stop]);

  const reset = useCallback(() => {
    stop();
    runId.current++;
    setState({ status: 'idle' });
  }, [stop]);

  useEffect(() => stop, [stop]); // terminate on unmount
  return { state, run, reset };
}
