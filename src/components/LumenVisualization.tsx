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

// Tab-separated plain-text fallback — pastes as columns in a spreadsheet even
// without HTML clipboard support, and (unlike commas) never collides with a
// locale's decimal/thousands separator inside a numeric cell.
function toTsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (value: unknown) => fmt(value).replace(/\t/g, " ").replace(/\n/g, " ");
  return [columns.map(esc).join("\t"), ...rows.map((row) => columns.map((col) => esc(row[col])).join("\t"))].join("\n");
}

// Real <table> markup for the clipboard's text/html slot — this is what lets
// a paste into Excel/Sheets/Docs land as actual cells instead of one blob of
// delimited text.
function toHtmlTable(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = `<tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((col) => `<td>${esc(fmt(row[col]))}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}

function seriesFor(block: LumenVizBlock, xKey: string): string[] {
  const requested = (block.series ?? []).filter((name) => block.columns.includes(name));
  if (requested.length) return requested;
  const sample = block.rows[0] ?? {};
  return block.columns.filter((col) => col !== xKey && isNumeric(sample[col]));
}

function BarChart({ block, expanded = false }: { block: LumenVizBlock; expanded?: boolean }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey).slice(0, 3);
  const rows = block.rows.slice(0, 18);
  if (!xKey || !series.length || !rows.length) return <p className="text-xs text-slate-400">Nothing numeric to chart.</p>;

  const width = 640;
  const height = expanded ? 420 : 260;
  const margin = { top: 16, right: 18, bottom: 44, left: 54 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = Math.max(...rows.flatMap((row) => series.map((name) => Math.max(0, Number(row[name]) || 0))), 1);
  const groupW = plotW / rows.length;
  const barW = Math.max(4, Math.min(22, (groupW - 8) / series.length));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={expanded ? "h-[26rem] w-full" : "h-56 w-full"} role="img">
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

function LineChart({ block, area = false, expanded = false }: { block: LumenVizBlock; area?: boolean; expanded?: boolean }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey).slice(0, 3);
  const rows = block.rows.slice(0, 40);
  if (!xKey || !series.length || rows.length < 2) return <p className="text-xs text-slate-400">Nothing numeric to chart.</p>;

  const width = 640;
  const height = expanded ? 420 : 260;
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
    <svg viewBox={`0 0 ${width} ${height}`} className={expanded ? "h-[26rem] w-full" : "h-56 w-full"} role="img">
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

function TableBlock({ block, expanded = false }: { block: LumenVizBlock; expanded?: boolean }) {
  const [copied, setCopied] = useState(false);
  const visibleRows = useMemo(() => block.rows.slice(0, 250), [block.rows]);

  async function copy() {
    const tsv = toTsv(block.columns, block.rows);
    try {
      // Write both representations so a paste into a spreadsheet lands as
      // real cells (text/html) while plain-text targets still get clean TSV.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        const html = toHtmlTable(block.columns, block.rows);
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([tsv], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(tsv);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <div
        className={`overflow-auto rounded-lg border border-slate-200 ${expanded ? "max-h-[calc(100vh-16rem)]" : "max-h-96"}`}
      >
        <table className={`min-w-full border-collapse text-left ${expanded ? "text-sm" : "text-[13px]"}`}>
          <thead className="sticky top-0 bg-slate-100 text-slate-600">
            <tr>
              {block.columns.map((col) => (
                <th
                  key={col}
                  className={`whitespace-nowrap border-b border-slate-200 font-semibold ${expanded ? "px-4 py-3" : "px-3 py-2.5"}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className="odd:bg-white even:bg-slate-50 hover:bg-blue-50/60">
                {block.columns.map((col) => (
                  <td
                    key={col}
                    className={`border-b border-slate-100 ${expanded ? "px-4 py-2.5" : "px-3 py-2"} ${isNumeric(row[col]) ? "text-right tabular-nums" : ""}`}
                  >
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
        <button type="button" onClick={copy} className="rounded-md bg-slate-100 px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-200">
          {copied ? "Copied" : "Copy table"}
        </button>
      </div>
    </div>
  );
}

export function LumenVisualization({ block, expanded = false }: { block: LumenVizBlock; expanded?: boolean }) {
  if (!block.rows.length) {
    return <div className="rounded-xl bg-white p-3 text-sm text-slate-400 ring-1 ring-slate-200">No data returned.</div>;
  }

  return (
    <div className={`rounded-xl bg-white text-slate-800 ring-1 ring-slate-200 ${expanded ? "p-4 text-base" : "p-3 text-sm"}`}>
      {block.title && <p className={`font-semibold text-slate-900 ${expanded ? "mb-4 text-base" : "mb-3 text-sm"}`}>{block.title}</p>}
      {block.kind === "table" || block.as === "table" ? (
        <TableBlock block={block} expanded={expanded} />
      ) : block.as === "line" ? (
        <LineChart block={block} expanded={expanded} />
      ) : block.as === "area" ? (
        <LineChart block={block} area expanded={expanded} />
      ) : block.as === "pie" ? (
        <PieChart block={block} />
      ) : (
        <BarChart block={block} expanded={expanded} />
      )}
    </div>
  );
}
