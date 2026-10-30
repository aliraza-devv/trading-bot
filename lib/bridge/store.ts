/**
 * store.ts - everything the MT5 bridge remembers, kept deliberately small:
 *   - the latest sync from the EA (what the Live page shows) and a rolling activity log, in memory
 *   - the rules the bridge trades with (saved from the backtester), as a JSON file
 *   - the pause switch, as a JSON file (a restart must not silently un-pause)
 *   - a journal of every decision, one JSON line each, for comparing demo results with the backtest later
 * Files live in ./live-data (git-ignored). The in-memory part sits on `globalThis` because Next compiles each
 * route into its own bundle: a plain module variable would be a different copy in every route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, validateConfig, type Config } from '@engine/config';
import type { BridgeMeta } from '@engine/bridge';
import type { LiveDecision, LiveOrder, LivePosition } from '@engine/live';

const DIR = process.env.BRIDGE_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'live-data');
const CONFIG_FILE = path.join(DIR, 'config.json');
const STATE_FILE = path.join(DIR, 'state.json');
const JOURNAL = path.join(DIR, 'decisions.jsonl');
const MAX_LOG = 200;

export interface BridgeSnapshot {
  receivedAt: number;
  meta: BridgeMeta;
  equity: number;
  demo: boolean;
  spreadNow: number;
  lastBarOpen: number;
  positions: LivePosition[];
  orders: LiveOrder[];
  decision: LiveDecision;
}

export interface LogEntry {
  t: number;
  kind: 'ea' | 'decision' | 'system';
  text: string;
}

interface BridgeMemory {
  snapshot: BridgeSnapshot | null;
  log: LogEntry[];
  paused: boolean;
  lastSignature: string;
}

const g = globalThis as unknown as { __irlBridge?: BridgeMemory };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
function writeJson(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch {
    return false; // read-only disk: the bridge still works, the setting just will not survive a restart
  }
}

function memory(): BridgeMemory {
  if (!g.__irlBridge) {
    g.__irlBridge = { snapshot: null, log: [], paused: readJson<{ paused?: boolean }>(STATE_FILE)?.paused === true, lastSignature: '' };
  }
  return g.__irlBridge;
}

function log(kind: LogEntry['kind'], text: string, t = Date.now()) {
  const m = memory();
  m.log.push({ t, kind, text });
  if (m.log.length > MAX_LOG) m.log.splice(0, m.log.length - MAX_LOG);
}

export const getSnapshot = () => memory().snapshot;
export const getLog = (n = 80) => memory().log.slice(-n);
export const isPaused = () => memory().paused;

/** A line in the Live page's activity list, marked as coming from you. */
export const logYou = (text: string): void => log('system', text);

export function setPaused(paused: boolean): void {
  memory().paused = paused;
  writeJson(STATE_FILE, { paused });
  log('system', paused ? 'Paused from the Live page: no new orders; resting orders are cancelled at the next sync.' : 'Resumed from the Live page.');
}

// ------------------------------------------------------------------------------------------ rules
export interface LiveConfigInfo {
  config: Config;
  /** true when the rules were saved from the backtester; false = the built-in defaults */
  custom: boolean;
  savedAt: number | null;
}

export function loadLiveConfig(): LiveConfigInfo {
  const saved = readJson<{ savedAt?: number; config?: Partial<Config> }>(CONFIG_FILE);
  if (!saved?.config) return { config: DEFAULT_CONFIG, custom: false, savedAt: null };
  const merged = { ...DEFAULT_CONFIG, ...saved.config };
  if (validateConfig(merged).length) return { config: DEFAULT_CONFIG, custom: false, savedAt: null }; // a corrupted file must not trade
  return { config: merged, custom: true, savedAt: saved.savedAt ?? null };
}

/** Keep only known keys whose type matches the default's, so a hand-edited or old file cannot inject nonsense. */
export function coerceConfig(input: unknown): Config {
  const out = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  if (input && typeof input === 'object') {
    for (const [k, def] of Object.entries(DEFAULT_CONFIG)) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined && typeof v === typeof def && Array.isArray(v) === Array.isArray(def)) out[k] = v;
    }
  }
  return out as unknown as Config;
}

export function saveLiveConfig(config: Config): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateConfig(config);
  if (errors.length) return { ok: false, errors };
  if (!writeJson(CONFIG_FILE, { savedAt: Date.now(), config })) return { ok: false, errors: ['Could not write the settings file (is the disk read-only?).'] };
  log('system', 'The bridge now uses the rules saved from the backtester.');
  return { ok: true };
}

export function resetLiveConfig(): void {
  try {
    fs.rmSync(CONFIG_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
  log('system', 'The bridge is back on the built-in default rules.');
}

// -------------------------------------------------------------------------------------------- sync
/** Called on every sync from the EA: remember it, log what is new, append to the journal. */
export function recordSync(s: BridgeSnapshot): void {
  const m = memory();
  m.snapshot = s;
  for (const e of s.meta.events) log('ea', e, s.receivedAt);

  // Log a decision only when it differs from the last one, otherwise a quiet market would flood the log.
  const d = s.decision;
  const acts = d.actions.map((a) =>
    a.type === 'place' ? `place ${a.key}`
    : a.type === 'renew' ? `renew ${a.ticket}`
    : a.type === 'cancel' ? `cancel ${a.ticket} (${a.reason})`
    : a.type === 'market' ? `test trade: ${a.direction === 1 ? 'buy' : 'sell'} at the market`
    : `trail ${a.ticket} to ${a.sl}`);
  const signature = `${d.status}|${acts.filter((x) => !x.startsWith('renew')).join(',')}|${d.notes[d.notes.length - 1] ?? ''}`;
  if (signature !== m.lastSignature) {
    m.lastSignature = signature;
    log('decision', `${d.status.toUpperCase()}: ${acts.length ? acts.join('; ') : 'no action'}. ${d.notes.join(' ')}`.trim(), s.receivedAt);
  }

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(
      JOURNAL,
      JSON.stringify({ t: s.receivedAt, equity: s.equity, status: d.status, asOf: d.asOf, spread: s.spreadNow, positions: s.positions.length, orders: s.orders.length, actions: d.actions, waiting: d.waiting.map((w) => [w.key, w.verdict, w.reason ?? null]) }) + '\n',
    );
  } catch {
    /* journal is a convenience, never a reason to fail a sync */
  }
}
