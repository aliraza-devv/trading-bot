'use client';

import { useState } from 'react';
import { CONFIG_FIELDS, DEFAULT_CONFIG, type Config, type FieldSpec } from '@engine/config';

/**
 * Settings form GENERATED from CONFIG_FIELDS - there is no hand-written field list here. Add a
 * field to the engine's Config + CONFIG_FIELDS and it appears. Fields of stages above `liveStage` are
 * hidden. List-valued fields (session / spread windows) get a small add-remove editor.
 */
export function ConfigForm({ config, onChange, liveStage }: { config: Config; onChange: (c: Config) => void; liveStage: 1 | 2 }) {
  const fields = CONFIG_FIELDS.filter((f) => f.stage <= liveStage);
  const groups = [...new Set(fields.map((f) => f.group))];
  const set = (key: keyof Config, value: Config[keyof Config]) => onChange({ ...config, [key]: value });
  // Number fields keep their own text while you type; bumping this key remounts them after a reset.
  const [resetKey, setResetKey] = useState(0);

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <fieldset key={g} className="space-y-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{g}</legend>
          {fields.filter((f) => f.group === g).map((f) => (
            <Field key={`${f.key}-${resetKey}`} spec={f} value={config[f.key]} onValue={(v) => set(f.key, v)} />
          ))}
        </fieldset>
      ))}
      <button type="button" onClick={() => { onChange({ ...DEFAULT_CONFIG }); setResetKey((k) => k + 1); }}
        className="text-xs text-zinc-400 underline hover:text-zinc-200">Reset to defaults</button>
    </div>
  );
}

function Field({ spec, value, onValue }: { spec: FieldSpec; value: unknown; onValue: (v: never) => void }) {
  const id = `cfg-${spec.key}`;
  const label = (
    <label htmlFor={id} className="block text-sm text-zinc-200" title={spec.help}>
      {spec.label}
      {spec.help && <span className="block text-xs text-zinc-500">{spec.help}</span>}
    </label>
  );
  if (spec.type === 'boolean') {
    return (
      <div className="flex items-start gap-2">
        <input id={id} type="checkbox" className="mt-1" checked={value as boolean}
          onChange={(e) => onValue(e.target.checked as never)} />
        {label}
      </div>
    );
  }
  if (spec.type === 'select') {
    return (
      <div className="space-y-1">
        {label}
        <select id={id} value={value as string} onChange={(e) => onValue(e.target.value as never)}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm">
          {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  }
  if (spec.type === 'number') {
    return <NumberField id={id} spec={spec} value={value as number} onValue={onValue as (v: number) => void} label={label} />;
  }
  return (
    <WindowListField id={id} label={label} withSpread={spec.type === 'spreadWindows'}
      value={value as Array<Array<string | number>>} onValue={onValue as (v: Array<Array<string | number>>) => void} />
  );
}

/** Editor for a list of UTC time windows: [from, to] or, with a spread, [from, to, spread]. */
function WindowListField({ id, label, value, withSpread, onValue }: {
  id: string; label: React.ReactNode; value: Array<Array<string | number>>; withSpread: boolean;
  onValue: (v: Array<Array<string | number>>) => void;
}) {
  const setRow = (i: number, col: number, v: string | number) => onValue(value.map((r, j) => (j === i ? r.map((x, c) => (c === col ? v : x)) : r)));
  const input = 'rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-sm';
  return (
    <div className="space-y-1" role="group" aria-labelledby={`${id}-label`}>
      <div id={`${id}-label`}>{label}</div>
      {value.length === 0 && <p className="text-xs text-zinc-500">No windows.</p>}
      {value.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <input type="time" aria-label="From" value={String(row[0])} onChange={(e) => setRow(i, 0, e.target.value)} className={input} />
          <span className="text-zinc-500">to</span>
          <input type="time" aria-label="To" value={String(row[1])} onChange={(e) => setRow(i, 1, e.target.value)} className={input} />
          {withSpread && (
            <>
              <span className="text-zinc-500">spread $</span>
              {/* commit on blur so typing "0.5" is not interrupted */}
              <input type="number" aria-label="Spread" min={0} step={0.05} defaultValue={Number(row[2])} className={`w-16 ${input}`}
                onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) setRow(i, 2, v); }} />
            </>
          )}
          <button type="button" aria-label="Remove window" onClick={() => onValue(value.filter((_, j) => j !== i))}
            className="px-1 text-zinc-400 hover:text-red-400">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onValue([...value, withSpread ? ['21:00', '23:00', 1] : ['07:00', '20:00']])}
        className="text-xs text-zinc-400 underline hover:text-zinc-200">+ Add window</button>
    </div>
  );
}

/** Is `text` a number this field accepts? (range + whole-number rules from the field spec) */
function parseNumber(text: string, spec: Extract<FieldSpec, { type: 'number' }>): number | null {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) return null;
  if (spec.min !== undefined && n < spec.min) return null;
  if (spec.max !== undefined && n > spec.max) return null;
  if (spec.step % 1 === 0 && !Number.isInteger(n)) return null;
  return n;
}

/** Keeps its own text while typing; only pushes a value up when it is valid. */
function NumberField({ id, spec, value, onValue, label }: {
  id: string; spec: Extract<FieldSpec, { type: 'number' }>; value: number; onValue: (v: number) => void; label: React.ReactNode;
}) {
  const [text, setText] = useState(String(value));
  const valid = parseNumber(text, spec) !== null;

  return (
    <div className="space-y-1">
      {label}
      <input id={id} type="number" inputMode="decimal" value={text} step={spec.step} min={spec.min} max={spec.max}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseNumber(e.target.value, spec);
          if (v !== null) onValue(v);
        }}
        aria-invalid={!valid}
        className={`w-full rounded border bg-zinc-900 px-2 py-1 text-sm ${valid ? 'border-zinc-700' : 'border-red-500'}`} />
      {!valid && <p className="text-xs text-red-400">
        {spec.step % 1 === 0 ? 'Whole number' : 'Number'}{spec.min !== undefined ? ` >= ${spec.min}` : ''}{spec.max !== undefined ? ` and <= ${spec.max}` : ''}
      </p>}
    </div>
  );
}
