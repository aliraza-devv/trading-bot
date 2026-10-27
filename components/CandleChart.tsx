'use client';

import dynamic from 'next/dynamic';
import type { Data, Layout } from 'plotly.js-dist-min';

// Plotly touches `window`, so it must only load in the browser. The factory + the prebuilt "dist-min"
// bundle keeps the install light and avoids bundling Plotly's own build tooling.
const Plot = dynamic(
  async () => {
    const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
      import('react-plotly.js/factory'),
      import('plotly.js-dist-min'),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createPlotlyComponent((Plotly as any).default ?? Plotly);
  },
  { ssr: false, loading: () => <div className="p-6 text-sm text-zinc-400">Loading chart…</div> },
);

export function CandleChart({ data, layout }: { data: Data[]; layout: Partial<Layout> }) {
  return (
    <Plot
      data={data}
      layout={layout}
      config={{ scrollZoom: true, displaylogo: false, responsive: true }}
      useResizeHandler
      style={{ width: '100%' }}
    />
  );
}
