'use client';

import { useState } from 'react';
import { CONFIG_FIELDS, DEFAULT_CONFIG, type Config, type FieldSpec } from '@engine/config';

/**
 * Settings form GENERATED from CONFIG_FIELDS - there is no hand-written field list here. Add a
 * field to the engine's Config + CONFIG_FIELDS and it appears. Only fields for stages that are
 * live are shown (`liveStage`); stage 2 fields stay hidden until the strategy exists.
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
  return null; // 'sessions' is a stage 2 control
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
