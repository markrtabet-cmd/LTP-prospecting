"use client";

import { useMemo, useState } from "react";

export type LumenVizBlock = {
  kind: "table" | "chart";
  as: "table" | "bar" | "line" | "area" | "pie";
  title?: string;
  x?: string | null;
  series?: string[] | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated?: boolean;
};

const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#db2777", "#7c3aed", "#0891b2", "#ea580c", "#475569"];

function isNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  return !Number.isNaN(Number(value));
}

function fmt(value: unknown): string {
  if (isNumeric(value)) {
    const n = Number(value);
    return Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }
  return String(value ?? "");
}

function short(value: unknown, max = 16): string {
  const text = fmt(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(esc).join(","), ...rows.map((row) => columns.map((col) => esc(row[col])).join(","))].join("\n");
}

function seriesFor(block: LumenVizBlock, xKey: string): string[] {
  const requested = (block.series ?? []).filter((name) => block.columns.includes(name));
  if (requested.length) return requested;
  const sample = block.rows[0] ?? {};
  return block.columns.filter((col) => col !== xKey && isNumeric(sample[col]));
}

function BarChart({ block }: { block: LumenVizBlock }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey).slice(0, 3);
  const rows = block.rows.slice(0, 18);
  if (!xKey || !series.length || !rows.length) return <p className="text-xs text-slate-400">Nothing numeric to chart.</p>;

  const width = 640;
  const height = 260;
  const margin = { top: 16, right: 18, bottom: 44, left: 54 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = Math.max(...rows.flatMap((row) => series.map((name) => Math.max(0, Number(row[name]) || 0))), 1);
  const groupW = plotW / rows.length;
  const barW = Math.max(4, Math.min(22, (groupW - 8) / series.length));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img">
      <line x1={margin.left} y1={margin.top + plotH} x2={width - margin.right} y2={margin.top + plotH} stroke="#cbd5e1" />
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + plotH} stroke="#cbd5e1" />
      {[0, 0.5, 1].map((tick) => {
        const y = margin.top + plotH - tick * plotH;
        return (
          <g key={tick}>
            <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} stroke="#e2e8f0" />
            <text x={margin.left - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[11px]">
              {fmt(max * tick)}
            </text>
          </g>
        );
      })}
      {rows.map((row, rowIndex) => {
        const groupX = margin.left + rowIndex * groupW + groupW / 2 - (barW * series.length) / 2;
        return (
          <g key={rowIndex}>
            {series.map((name, seriesIndex) => {
              const value = Math.max(0, Number(row[name]) || 0);
              const h = (value / max) * plotH;
              return (
                <rect
                  key={name}
                  x={groupX + seriesIndex * barW}
                  y={margin.top + plotH - h}
                  width={barW}
                  height={h}
                  rx={3}
                  fill={COLORS[seriesIndex % COLORS.length]}
                />
              );
            })}
            <text x={margin.left + rowIndex * groupW + groupW / 2} y={height - 20} textAnchor="middle" className="fill-slate-500 text-[10px]">
              {short(row[xKey], 12)}
            </text>
          </g>
        );
      })}
      <Legend series={series} />
    </svg>
  );
}

function LineChart({ block, area = false }: { block: LumenVizBlock; area?: boolean }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey).slice(0, 3);
  const rows = block.rows.slice(0, 40);
  if (!xKey || !series.length || rows.length < 2) return <p className="text-xs text-slate-400">Nothing numeric to chart.</p>;

  const width = 640;
  const height = 260;
  const margin = { top: 16, right: 18, bottom: 44, left: 54 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = rows.flatMap((row) => series.map((name) => Number(row[name]) || 0));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const xy = (row: Record<string, unknown>, i: number, name: string) => {
    const x = margin.left + (i / Math.max(rows.length - 1, 1)) * plotW;
    const y = margin.top + plotH - ((Number(row[name]) || 0) - min) / span * plotH;
    return [x, y] as const;
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img">
      <line x1={margin.left} y1={margin.top + plotH} x2={width - margin.right} y2={margin.top + plotH} stroke="#cbd5e1" />
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + plotH} stroke="#cbd5e1" />
      {[min, min + span / 2, max].map((tick) => {
        const y = margin.top + plotH - ((tick - min) / span) * plotH;
        return (
          <g key={tick}>
            <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} stroke="#e2e8f0" />
            <text x={margin.left - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[11px]">
              {fmt(tick)}
            </text>
          </g>
        );
      })}
      {series.map((name, seriesIndex) => {
        const points = rows.map((row, i) => xy(row, i, name));
        const line = points.map(([x, y]) => `${x},${y}`).join(" ");
        const fill = `${points[0][0]},${margin.top + plotH} ${line} ${points[points.length - 1][0]},${margin.top + plotH}`;
        return (
          <g key={name}>
            {area && <polygon points={fill} fill={COLORS[seriesIndex % COLORS.length]} opacity={0.14} />}
            <polyline points={line} fill="none" stroke={COLORS[seriesIndex % COLORS.length]} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
            {points.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={2.5} fill={COLORS[seriesIndex % COLORS.length]} />
            ))}
          </g>
        );
      })}
      {[0, Math.floor((rows.length - 1) / 2), rows.length - 1].map((i) => (
        <text key={i} x={xy(rows[i], i, series[0])[0]} y={height - 20} textAnchor="middle" className="fill-slate-500 text-[10px]">
          {short(rows[i][xKey], 14)}
        </text>
      ))}
      <Legend series={series} />
    </svg>
  );
}

function PieChart({ block }: { block: LumenVizBlock }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey);
  const valueKey = series[0];
  const rows = block.rows.slice(0, 8);
  if (!xKey || !valueKey || !rows.length) return <p className="text-xs text-slate-400">Nothing numeric to chart.</p>;

  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row[valueKey]) || 0), 0) || 1;
  let start = -90;
  const slices = rows.map((row, i) => {
    const value = Math.max(0, Number(row[valueKey]) || 0);
    const degrees = (value / total) * 360;
    const slice = { row, value, start, end: start + degrees, color: COLORS[i % COLORS.length] };
    start += degrees;
    return slice;
  });

  const path = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const rad = (deg: number) => (Math.PI / 180) * deg;
    const x0 = cx + r * Math.cos(rad(a0));
    const y0 = cy + r * Math.sin(rad(a0));
    const x1 = cx + r * Math.cos(rad(a1));
    const y1 = cy + r * Math.sin(rad(a1));
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  };

  return (
    <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
      <svg viewBox="0 0 200 200" className="mx-auto h-44 w-44" role="img">
        {slices.map((slice, i) => (
          <path key={i} d={path(100, 100, 86, slice.start, slice.end)} fill={slice.color} stroke="#fff" strokeWidth={2} />
        ))}
        <circle cx={100} cy={100} r={44} fill="#fff" />
      </svg>
      <div className="space-y-2">
        {slices.map((slice, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
            <span className="min-w-0 flex-1 truncate text-slate-600">{fmt(slice.row[xKey])}</span>
            <span className="font-medium text-slate-800">{Math.round((slice.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ series }: { series: string[] }) {
  if (series.length <= 1) return null;
  return (
    <g>
      {series.map((name, i) => (
        <g key={name} transform={`translate(${68 + i * 150}, 14)`}>
          <circle cx={0} cy={0} r={5} fill={COLORS[i % COLORS.length]} />
          <text x={10} y={4} className="fill-slate-500 text-[11px]">
            {short(name, 18)}
          </text>
        </g>
      ))}
    </g>
  );
}

function TableBlock({ block }: { block: LumenVizBlock }) {
  const [copied, setCopied] = useState(false);
  const visibleRows = useMemo(() => block.rows.slice(0, 250), [block.rows]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(toCsv(block.columns, block.rows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500">
            <tr>
              {block.columns.map((col) => (
                <th key={col} className="border-b border-slate-200 px-2 py-2 font-semibold">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className="odd:bg-white even:bg-slate-50/70">
                {block.columns.map((col) => (
                  <td key={col} className={`border-b border-slate-100 px-2 py-1.5 ${isNumeric(row[col]) ? "text-right tabular-nums" : ""}`}>
                    {fmt(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
        <span>
          {block.rowCount.toLocaleString("en-GB")} rows{visibleRows.length < block.rows.length ? `, showing ${visibleRows.length}` : ""}
        </span>
        <button type="button" onClick={copy} className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600 hover:bg-slate-200">
          {copied ? "Copied" : "Copy CSV"}
        </button>
      </div>
    </div>
  );
}

export function LumenVisualization({ block }: { block: LumenVizBlock }) {
  if (!block.rows.length) {
    return <div className="rounded-xl bg-white p-3 text-sm text-slate-400 ring-1 ring-slate-200">No data returned.</div>;
  }

  return (
    <div className="rounded-xl bg-white p-3 text-sm text-slate-800 ring-1 ring-slate-200">
      {block.title && <p className="mb-3 text-sm font-semibold text-slate-900">{block.title}</p>}
      {block.kind === "table" || block.as === "table" ? (
        <TableBlock block={block} />
      ) : block.as === "line" ? (
        <LineChart block={block} />
      ) : block.as === "area" ? (
        <LineChart block={block} area />
      ) : block.as === "pie" ? (
        <PieChart block={block} />
      ) : (
        <BarChart block={block} />
      )}
    </div>
  );
}
