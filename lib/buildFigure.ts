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
import type { Candle, Structure } from '@engine/types';

export const COLORS = {
  surface: '#1a1a19', grid: '#2c2c2a', axis: '#383835', text: '#c3c2b7', muted: '#898781',
  bull: '#3987e5', bear: '#d95926', candleUpLine: '#c3c2b7', candleDown: '#898781',
};

export interface Layers { swings: boolean; fvg: boolean; bos: boolean; pd: boolean }
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
export function buildFigure(c: Candle[], s: Structure, tfMs: number, lo: number, hi: number, layers: Layers, title: string, height: number) {
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
