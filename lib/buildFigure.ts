/**
 * buildFigure.ts - turns candles + detector output into a Plotly figure (Stage 1: detectors only).
 *
 * Each layer is its own add*() function, so Stage 2 can add entries / exits / SL / TP layers
 * without touching these. Direction colour is ONE blue/orange pair everywhere (blue = bullish,
 * orange = bearish), chosen to stay distinguishable under colour-vision deficiency; candles are
 * neutral (hollow = up, filled = down) so the overlays own the colour. Edit COLORS to restyle.
 *
 * The detectors run on the FULL series; this module only crops to the visible window [lo, hi).
 */
import type { Data, Layout } from 'plotly.js-dist-min';
import type { Candle, Structure, Trade } from '@engine/types';

export const COLORS = {
  surface: '#1a1a19', grid: '#2c2c2a', axis: '#383835', text: '#c3c2b7', muted: '#898781',
  bull: '#3987e5', bear: '#d95926', candleUpLine: '#c3c2b7', candleDown: '#898781',
};

export interface Layers { swings: boolean; fvg: boolean; bos: boolean; pd: boolean; trades: boolean }
type Trace = Record<string, unknown>;

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const nn = (v: number) => (Number.isNaN(v) ? null : v);

/** Append a closed rectangle plus a null separator (one trace can hold many rectangles). */
function rect(xs: Array<string | null>, ys: Array<number | null>, x0: string, x1: string, y0: number, y1: number) {
  xs.push(x0, x1, x1, x0, x0, null);
  ys.push(y0, y0, y1, y1, y0, null);
}

/** Hide every missing bar slot (weekends, holidays) so candles sit side by side. */
function rangeBreaks(c: Candle[], lo: number, hi: number, tfMs: number) {
  const have = new Set<number>();
  for (let i = lo; i < hi; i++) have.add(c[i].time);
  const missing: string[] = [];
  for (let t = c[lo].time; t <= c[hi - 1].time; t += tfMs) if (!have.has(t)) missing.push(fmt(t));
  return missing.length ? [{ values: missing, dvalue: tfMs }] : [];
}

// ------------------------------------------------------------------------------------ layers
function addPremiumDiscount(data: Trace[], c: Candle[], s: Structure, lo: number, hi: number, tfMs: number) {
  const b = s.bars;
  const px: Array<string | null> = [], py: Array<number | null> = [];
  const dx: Array<string | null> = [], dy: Array<number | null> = [];
  // One rectangle per run of bars that share the same dealing range; bars with no range draw nothing.
  for (let t = lo; t < hi; ) {
    if (Number.isNaN(b.rangeHigh[t])) { t++; continue; }
    let e = t;
    while (e + 1 < hi && b.rangeHigh[e + 1] === b.rangeHigh[t] && b.rangeLow[e + 1] === b.rangeLow[t]) e++;
    const x0 = fmt(c[t].time);
    const x1 = fmt(e + 1 < hi ? c[e + 1].time : c[e].time + tfMs);
    rect(px, py, x0, x1, b.eq[t], b.rangeHigh[t]);
    rect(dx, dy, x0, x1, b.rangeLow[t], b.eq[t]);
    t = e + 1;
  }
  const fill = (x: Array<string | null>, y: Array<number | null>, name: string, color: string) =>
    x.length && data.push({ type: 'scatter', mode: 'lines', x, y, fill: 'toself', name, legendgroup: 'pd',
      fillcolor: rgba(color, 0.1), line: { width: 0 }, hoverinfo: 'skip' });
  fill(px, py, 'Premium (above EQ)', COLORS.bear);
  fill(dx, dy, 'Discount (below EQ)', COLORS.bull);
  const xs: string[] = [], eq: Array<number | null> = [];
  for (let t = lo; t < hi; t++) { xs.push(fmt(c[t].time)); eq.push(nn(b.eq[t])); }
  data.push({ type: 'scatter', mode: 'lines', x: xs, y: eq, name: 'EQ (50%)', legendgroup: 'pd', connectgaps: false,
    line: { color: COLORS.muted, width: 1, dash: 'dot', shape: 'hv' }, hoverinfo: 'skip' });
}

function addFvgs(data: Trace[], c: Candle[], s: Structure, lo: number, hi: number) {
  const vis = s.fvgs.filter((f) => f.confirmIdx < hi && (f.endIdx === -1 || f.endIdx >= lo));
  for (const [dir, name, color] of [[1, 'FVG bullish', COLORS.bull], [-1, 'FVG bearish', COLORS.bear]] as const) {
    const xs: Array<string | null> = [], ys: Array<number | null> = [];
    const hx: string[] = [], hy: number[] = [], ht: string[] = [];
    for (const f of vis.filter((v) => v.direction === dir)) {
      const i0 = Math.max(f.idxMid, lo);
      const i1 = Math.max(f.endIdx === -1 || f.endIdx >= hi ? hi - 1 : f.endIdx, i0);
      rect(xs, ys, fmt(c[i0].time), fmt(c[i1].time), f.bottom, f.top);
      hx.push(fmt(c[i0].time + (c[i1].time - c[i0].time) / 2));
      hy.push(f.ce);
      ht.push(`${name}<br>${f.bottom.toFixed(2)} - ${f.top.toFixed(2)} (size ${f.size.toFixed(2)})<br>known from ${fmt(f.confirmTime)}<br>ends: ${f.endReason}`);
    }
    if (!xs.length) continue;
    data.push({ type: 'scatter', mode: 'lines', x: xs, y: ys, fill: 'toself', name, legendgroup: name,
      fillcolor: rgba(color, 0.22), line: { color: rgba(color, 0.7), width: 0.8 }, hoverinfo: 'skip' });
    // Invisible markers carry the hover text for the whole box.
    data.push({ type: 'scatter', mode: 'markers', x: hx, y: hy, showlegend: false, legendgroup: name,
      marker: { size: 12, opacity: 0 }, text: ht, hoverinfo: 'text' });
  }
}

function addBos(data: Trace[], c: Candle[], s: Structure, lo: number, hi: number) {
  const vis = s.bos.filter((b) => b.idx >= lo && b.idx < hi);
  for (const [dir, name, color] of [[1, 'BOS bullish', COLORS.bull], [-1, 'BOS bearish', COLORS.bear]] as const) {
    const xs: Array<string | null> = [], ys: Array<number | null> = [];
    const mx: string[] = [], my: number[] = [], mt: string[] = [];
    for (const b of vis.filter((v) => v.direction === dir)) {
      const t0 = c[Math.max(b.swingIdx, lo)].time;
      const t1 = c[b.idx].time;
      xs.push(fmt(t0), fmt(t1), null);
      ys.push(b.level, b.level, null);
      mx.push(fmt(t0 + (t1 - t0) / 2));
      my.push(b.level);
      mt.push(`${name} (${b.kind})<br>level ${b.level.toFixed(2)}<br>closed through at ${fmt(b.confirmTime)}`);
    }
    if (!xs.length) continue;
    data.push({ type: 'scatter', mode: 'lines', x: xs, y: ys, name, legendgroup: name,
      line: { color, width: 1.2, dash: 'dash' }, hoverinfo: 'skip' });
    data.push({ type: 'scatter', mode: 'text', x: mx, y: my, text: mx.map(() => 'BOS'), textposition: 'top center',
      textfont: { color, size: 10 }, showlegend: false, legendgroup: name, hovertext: mt, hoverinfo: 'text' });
  }
}

function addSwings(data: Trace[], s: Structure, lo: number, hi: number, pad: number) {
  for (const [kind, name, symbol, sign] of [['high', 'Swing high', 'triangle-down', 1], ['low', 'Swing low', 'triangle-up', -1]] as const) {
    const sw = s.swings.filter((x) => x.kind === kind && x.idx >= lo && x.idx < hi);
    if (!sw.length) continue;
    data.push({ type: 'scatter', mode: 'markers', name, x: sw.map((x) => fmt(x.time)), y: sw.map((x) => x.price + sign * pad),
      marker: { symbol, size: 8, color: COLORS.text, line: { color: COLORS.surface, width: 1 } },
      text: sw.map((x) => `${name} ${x.price.toFixed(2)}<br>pivot bar ${fmt(x.time)}<br>known from ${fmt(x.confirmTime)}`),
      hoverinfo: 'text' });
  }
}

// ------------------------------------------------------------------------------------ figure
// ------------------------------------------------------------------------------------ trades
// Outcome colours are the reserved status pair (good / critical), never the bullish/bearish pair, so
// "this trade won" is never confused with "this gap is bullish".
export const GOOD = '#0ca30c';
export const BAD = '#d03b3b';

export interface TradeOverlay { trades: Trade[]; selectedId: number | null; finalTpR: number }

const signed = (v: number, dp = 2) => (v >= 0 ? '+' : '') + v.toFixed(dp);

function tradeHover(t: Trade): string {
  const last = t.exits[t.exits.length - 1];
  return `Trade #${t.id} ${t.direction === 1 ? 'LONG' : 'SHORT'} (${t.timeframe} gap)<br>${signed(t.rMultiple)}R net · ${t.pnl.toFixed(2)}`
    + `<br>entry ${fmt(t.entry.time)} @ ${t.entry.price.toFixed(2)}<br>last exit ${fmt(last.time)} (${t.endedBy})`
    + `<br>stop ${t.stopLoss.toFixed(2)} · ERL ${t.poi.erl.toFixed(2)} · best ${t.maxFavorableR.toFixed(2)}R`;
}

/** Entries, exits, stop / target lines and the entry-to-exit path. Works on either timeframe's chart. */
function addTrades(data: Trace[], c: Candle[], tfMs: number, lo: number, hi: number, ov: TradeOverlay) {
  const t0 = c[lo].time;
  const t1 = c[hi - 1].time + tfMs;
  const lastOf = (t: Trade) => t.exits[t.exits.length - 1];
  const vis = ov.trades.filter((t) => t.entry.time <= t1 && lastOf(t).time >= t0);
  if (!vis.length) return;

  const lines = (ts: Trade[], from: (t: Trade) => number, to: (t: Trade) => number) => {
    const x: Array<string | null> = [];
    const y: Array<number | null> = [];
    for (const t of ts) {
      x.push(fmt(t.entry.time), fmt(lastOf(t).time), null);
      y.push(from(t), to(t), null);
    }
    return { x, y };
  };
  const stopY = (t: Trade) => t.stopLoss;
  const tpY = (t: Trade) => t.entryLevel + t.direction * ov.finalTpR * t.riskPerUnit;
  const style = (color: string, width: number, dash?: string) => ({ color, width, dash });
  const add = (name: string, ts: Trade[], from: (t: Trade) => number, to: (t: Trade) => number, line: object, group: string, legend: boolean) => {
    if (ts.length) data.push({ type: 'scatter', mode: 'lines', name, legendgroup: group, showlegend: legend, line, hoverinfo: 'skip', ...lines(ts, from, to) });
  };

  const wins = vis.filter((t) => t.pnl > 0);
  const losses = vis.filter((t) => t.pnl <= 0);
  add('Stop loss', vis, stopY, stopY, style(BAD, 1, 'dash'), 'sl', true);
  add('Target (final TP)', vis, tpY, tpY, style(GOOD, 1, 'dot'), 'tp', true);
  add('Trade (win)', wins, (t) => t.entry.price, (t) => lastOf(t).price, style(GOOD, 2), 'win', true);
  add('Trade (loss)', losses, (t) => t.entry.price, (t) => lastOf(t).price, style(BAD, 2), 'loss', true);

  const sel = vis.filter((t) => t.id === ov.selectedId);
  if (sel.length) { // the clicked trade, drawn thicker on top of everything
    add('Selected stop', sel, stopY, stopY, style(BAD, 2.5, 'dash'), 'sel', false);
    add('Selected target', sel, tpY, tpY, style(GOOD, 2.5, 'dot'), 'sel', false);
    add('Selected trade', sel, (t) => t.entry.price, (t) => lastOf(t).price, style(sel[0].pnl > 0 ? GOOD : BAD, 4), 'sel', false);
  }

  data.push({
    type: 'scatter', mode: 'markers', name: 'Entry', x: vis.map((t) => fmt(t.entry.time)), y: vis.map((t) => t.entry.price),
    marker: { symbol: 'diamond', size: 10, color: COLORS.text, line: { color: COLORS.surface, width: 1 } },
    text: vis.map(tradeHover), hoverinfo: 'text',
  });
  const exits = vis.flatMap((t) => t.exits.map((f) => ({ t, f })));
  data.push({
    type: 'scatter', mode: 'markers', name: 'Exit', x: exits.map((e) => fmt(e.f.time)), y: exits.map((e) => e.f.price),
    marker: {
      symbol: exits.map((e) => (e.f.reason === 'partial' ? 'circle' : 'x')), size: 9,
      color: exits.map((e) => (e.f.pnl > 0 ? GOOD : BAD)), line: { color: COLORS.surface, width: 1 },
    },
    text: exits.map((e) => `${e.f.reason} @ ${e.f.price.toFixed(2)} (${e.f.lots} lots)<br>${tradeHover(e.t)}`), hoverinfo: 'text',
  });
}

export function buildFigure(c: Candle[], s: Structure, tfMs: number, lo: number, hi: number, layers: Layers, title: string, height: number, overlay?: TradeOverlay) {
  const view = c.slice(lo, hi);
  const pHigh = Math.max(...view.map((x) => x.high));
  const pLow = Math.min(...view.map((x) => x.low));
  const pad = (pHigh - pLow) * 0.008; // marker offset only; hover shows the true price

  // Draw order = z-order: shaded layers first, candles above them, lines/markers on top.
  const data: Trace[] = [];
  if (layers.pd) addPremiumDiscount(data, c, s, lo, hi, tfMs);
  if (layers.fvg) addFvgs(data, c, s, lo, hi);
  data.push({
    type: 'candlestick', name: 'Price', showlegend: false,
    x: view.map((x) => fmt(x.time)), open: view.map((x) => x.open), high: view.map((x) => x.high),
    low: view.map((x) => x.low), close: view.map((x) => x.close),
    increasing: { line: { color: COLORS.candleUpLine, width: 1 }, fillcolor: COLORS.surface },
    decreasing: { line: { color: COLORS.candleDown, width: 1 }, fillcolor: COLORS.candleDown },
  });
  if (layers.bos) addBos(data, c, s, lo, hi);
  if (layers.swings) addSwings(data, s, lo, hi, pad);
  if (layers.trades && overlay) addTrades(data, c, tfMs, lo, hi, overlay);

  const yPad = (pHigh - pLow) * 0.05;
  const layout: Partial<Layout> = {
    title: { text: title, x: 0, y: 0.985, yanchor: 'top', font: { size: 15, color: COLORS.text } },
    height, margin: { l: 60, r: 60, t: 125, b: 40 },
    paper_bgcolor: COLORS.surface, plot_bgcolor: COLORS.surface,
    font: { color: COLORS.text, size: 12 },
    xaxis: { rangeslider: { visible: false }, gridcolor: COLORS.grid, linecolor: COLORS.axis, rangebreaks: rangeBreaks(c, lo, hi, tfMs) },
    // Default y-range = visible PRICE, so far-away unfilled FVGs don't squash the candles.
    // Double-click the chart to return to this view.
    yaxis: { gridcolor: COLORS.grid, linecolor: COLORS.axis, side: 'right', tickformat: '.2f', range: [pLow - yPad, pHigh + yPad] },
    hovermode: 'closest', dragmode: 'pan',
    legend: { orientation: 'h', y: 1.01, x: 0, yanchor: 'bottom', bgcolor: 'rgba(0,0,0,0)' },
    // Same key => toggling a layer keeps your zoom; a new window / timeframe resets it.
    uirevision: `${tfMs}-${lo}-${hi}`,
  };
  return { data: data as unknown as Data[], layout };
}

// ------------------------------------------------------------------------- results charts
const small = (title: string, height: number): Partial<Layout> => ({
  title: { text: title, x: 0, font: { size: 14, color: COLORS.text } }, height, margin: { l: 60, r: 20, t: 40, b: 40 },
  paper_bgcolor: COLORS.surface, plot_bgcolor: COLORS.surface, font: { color: COLORS.text, size: 12 },
  xaxis: { gridcolor: COLORS.grid, linecolor: COLORS.axis }, yaxis: { gridcolor: COLORS.grid, linecolor: COLORS.axis },
  showlegend: false,
});

/** Realised equity after each closed trade, with the drawdown from the running peak shaded. */
export function buildEquityFigure(eq: Array<{ time: number; equity: number }>, startEquity: number) {
  let peak = -Infinity;
  const peaks = eq.map((p) => (peak = Math.max(peak, p.equity)));
  const x = eq.map((p) => fmt(p.time));
  const data = [
    { type: 'scatter', mode: 'lines', x, y: peaks, line: { width: 0, shape: 'hv' }, hoverinfo: 'skip' },
    { type: 'scatter', mode: 'lines', x, y: eq.map((p) => p.equity), name: 'Equity', fill: 'tonexty', fillcolor: rgba(COLORS.bear, 0.2),
      line: { color: COLORS.text, width: 1.5, shape: 'hv' }, hovertemplate: '%{x}<br>$%{y:,.2f}<extra></extra>' },
  ] as unknown as Data[];
  const layout = small('Equity (realised, after all costs) - shaded = drawdown from peak', 300);
  layout.yaxis = { ...layout.yaxis, tickformat: '$,.0f' };
  layout.shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: startEquity, y1: startEquity, line: { color: COLORS.muted, width: 1, dash: 'dot' } }];
  return { data, layout };
}

/** Histogram of trade results in R (losing bins in the critical colour, winning bins in the good one). */
export function buildRDistFigure(bins: Array<{ label: string; from: number; to: number; count: number }>) {
  const data = [{
    type: 'bar', x: bins.map((b) => b.label), y: bins.map((b) => b.count),
    marker: { color: bins.map((b) => (b.to <= 0 ? BAD : GOOD)) }, hovertemplate: '%{x} R: %{y} trades<extra></extra>',
  }] as unknown as Data[];
  const layout = small('Distribution of trade results (R)', 260);
  layout.xaxis = { ...layout.xaxis, tickangle: -45, type: 'category' };
  return { data, layout };
}
