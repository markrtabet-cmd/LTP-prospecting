"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CopyTableButton } from "@/components/CopyTableButton";
import { displayCell as fmt, isNumeric } from "@/lib/tableExport";

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

// Categorical palette = the dataviz reference instance (CVD-safe, fixed order —
// never cycled). Slot 1 (blue) is the single-series default.
const SERIES = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
// Chart chrome carries the app's warm-neutral ink, never a data colour.
const INK = "#211d1c";
const SECONDARY = "#57504d";
const MUTED = "#9a928e";
const GRID = "#efeae8";
const AXIS = "#d9d2ce";
const SURFACE = "#ffffff";

// ── number formatting ──────────────────────────────────────────────────────
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Compact axis/label form: 1.2K · 3.4M · 5B — keeps big revenue numbers legible.
function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return sign + trimZero(abs / 1e9) + "B";
  if (abs >= 1e6) return sign + trimZero(abs / 1e6) + "M";
  if (abs >= 1e3) return sign + trimZero(abs / 1e3) + "K";
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : trimZero(n);
}
function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// ── nice axis scales ────────────────────────────────────────────────────────
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const f = rough / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}
function niceScale(dataMin: number, dataMax: number, count = 4): { min: number; max: number; ticks: number[] } {
  let min = Math.min(dataMin, dataMax);
  let max = Math.max(dataMin, dataMax);
  if (min === max) max = min + 1;
  const step = niceStep((max - min) / count);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min, max, ticks };
}

// ── mark geometry (rounded data-end, square at the baseline) ────────────────
function colPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}
function barPath(x: number, y: number, w: number, h: number, r: number, round: "left" | "right"): string {
  const rr = Math.max(0, Math.min(r, h / 2, w));
  if (round === "left") {
    return `M${x + rr},${y} Q${x},${y} ${x},${y + rr} L${x},${y + h - rr} Q${x},${y + h} ${x + rr},${y + h} L${x + w},${y + h} L${x + w},${y} Z`;
  }
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y} Z`;
}

// ── shared hooks / pieces ───────────────────────────────────────────────────
// Measure the container so the SVG renders 1:1 in real pixels (no viewBox
// letterboxing / text scaling, and pointer coordinates map straight to marks).
function useWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || fallback);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return { ref, width };
}

type Tip = { x: number; y: number; title?: string; lines: { label: string; value: string; color?: string }[] };

function ChartTooltip({ tip, width }: { tip: Tip; width: number }) {
  const flip = tip.x > width * 0.6;
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-[240px] rounded-lg bg-slate-900/95 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg"
      style={{ left: tip.x, top: tip.y, transform: `translate(${flip ? "-100%" : "0"}, -115%)`, marginLeft: flip ? -8 : 8 }}
    >
      {tip.title && <div className="mb-0.5 max-w-[220px] truncate font-semibold">{tip.title}</div>}
      {tip.lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2 whitespace-nowrap">
          {l.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />}
          <span className="text-white/70">{l.label}</span>
          <span className="ml-auto font-semibold tabular-nums">{l.value}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: string[] }) {
  if (series.length <= 1) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
      {series.map((name, i) => (
        <span key={name} className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} />
          {truncate(name, 22)}
        </span>
      ))}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <p className="py-6 text-center text-xs text-slate-400">{msg}</p>;
}

function seriesFor(block: LumenVizBlock, xKey: string): string[] {
  const requested = (block.series ?? []).filter((name) => block.columns.includes(name) && name !== xKey);
  if (requested.length) return requested;
  const sample = block.rows[0] ?? {};
  return block.columns.filter((col) => col !== xKey && isNumeric(sample[col]));
}

// ── horizontal bars — single series, sorted; the readable answer for many /
// long category labels (top products, regions, customers by value) ──────────
function HorizontalBars({ block, xKey, valueKey, expanded }: { block: LumenVizBlock; xKey: string; valueKey: string; expanded: boolean }) {
  const { ref, width } = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);

  const rows = useMemo(
    () =>
      block.rows
        .map((r) => ({ label: fmt(r[xKey]), value: num(r[valueKey]) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, expanded ? 24 : 14),
    [block.rows, xKey, valueKey, expanded]
  );

  const rowH = expanded ? 30 : 25;
  const barH = Math.min(rowH - 9, 22);
  const topPad = 6;
  const bottomAxis = 24;
  const height = topPad + rows.length * rowH + bottomAxis;

  const longest = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const gutter = Math.round(Math.max(56, Math.min(longest * 6.4 + 12, width * 0.42, 190)));
  const rightPad = 46;
  const x0 = gutter;
  const plotW = Math.max(10, width - gutter - rightPad);

  const dataMin = Math.min(0, ...rows.map((r) => r.value));
  const dataMax = Math.max(0, ...rows.map((r) => r.value));
  const scale = niceScale(dataMin, dataMax);
  const sx = (v: number) => x0 + ((v - scale.min) / (scale.max - scale.min)) * plotW;
  const zeroX = sx(0);
  const gutterChars = Math.max(4, Math.floor((gutter - 12) / 6.4));

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={block.title || "Bar chart"}>
        {/* vertical gridlines + value axis */}
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} y1={topPad} x2={sx(t)} y2={topPad + rows.length * rowH} stroke={t === 0 ? AXIS : GRID} />
            <text x={sx(t)} y={height - 8} textAnchor="middle" fontSize={10.5} fill={MUTED}>
              {compact(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = topPad + i * rowH + (rowH - barH) / 2;
          const vx = sx(r.value);
          const left = Math.min(zeroX, vx);
          const w = Math.max(r.value === 0 ? 0 : 2, Math.abs(vx - zeroX));
          const pos = r.value >= 0;
          const labelInside = pos ? vx + rightPad > width - 4 : vx - rightPad < x0;
          return (
            <g key={i}>
              <text x={x0 - 8} y={y + barH / 2 + 3.5} textAnchor="end" fontSize={11.5} fill={SECONDARY}>
                {truncate(r.label, gutterChars)}
              </text>
              <path d={barPath(left, y, w, barH, 4, pos ? "right" : "left")} fill={SERIES[0]} />
              <text
                x={pos ? (labelInside ? vx - 6 : vx + 6) : labelInside ? vx + 6 : vx - 6}
                y={y + barH / 2 + 3.5}
                textAnchor={pos ? (labelInside ? "end" : "start") : labelInside ? "start" : "end"}
                fontSize={11}
                fontWeight={600}
                fill={labelInside ? "#fff" : INK}
              >
                {compact(r.value)}
              </text>
            </g>
          );
        })}
        {/* pointer band → tooltip for the hovered row */}
        <rect
          x={0}
          y={topPad}
          width={width}
          height={rows.length * rowH}
          fill="transparent"
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const i = Math.floor((e.clientY - box.top) / rowH);
            const r = rows[i];
            if (!r) return setTip(null);
            setTip({ x: e.clientX - box.left, y: topPad + i * rowH + rowH / 2, title: r.label, lines: [{ label: valueKey, value: fmt(r.value), color: SERIES[0] }] });
          }}
          onMouseLeave={() => setTip(null)}
        />
      </svg>
      {tip && <ChartTooltip tip={tip} width={width} />}
    </div>
  );
}

// ── vertical grouped columns — multi-series category comparison ─────────────
function Columns({ block, xKey, series, expanded }: { block: LumenVizBlock; xKey: string; series: string[]; expanded: boolean }) {
  const { ref, width } = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);

  const rows = useMemo(() => block.rows.slice(0, 12), [block.rows]);
  const height = expanded ? 340 : 264;
  const margin = { top: 10, right: 12, bottom: 58, left: 46 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;

  const dataMax = Math.max(0, ...rows.flatMap((r) => series.map((s) => num(r[s]))));
  const scale = niceScale(0, dataMax);
  const sy = (v: number) => margin.top + plotH - (v / scale.max) * plotH;
  const groupW = plotW / rows.length;
  const gap = 2;
  const barW = Math.max(4, Math.min(24, (groupW * 0.72 - gap * (series.length - 1)) / series.length));
  const labelEvery = Math.ceil((rows.length * 46) / plotW); // thin x-labels if crowded

  return (
    <div ref={ref} className="w-full">
      <Legend series={series} />
      <div className="relative">
      <svg width={width} height={height} role="img" aria-label={block.title || "Column chart"}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={margin.left} y1={sy(t)} x2={width - margin.right} y2={sy(t)} stroke={GRID} />
            <text x={margin.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10.5} fill={MUTED}>
              {compact(t)}
            </text>
          </g>
        ))}
        <line x1={margin.left} y1={margin.top + plotH} x2={width - margin.right} y2={margin.top + plotH} stroke={AXIS} />
        {rows.map((row, ri) => {
          const cx = margin.left + ri * groupW + groupW / 2;
          const groupLeft = cx - (barW * series.length + gap * (series.length - 1)) / 2;
          return (
            <g key={ri}>
              {series.map((name, si) => {
                const v = num(row[name]);
                const y = sy(Math.max(0, v));
                const h = margin.top + plotH - y;
                return <path key={name} d={colPath(groupLeft + si * (barW + gap), y, barW, h, 4)} fill={SERIES[si % SERIES.length]} />;
              })}
              {ri % labelEvery === 0 && (
                <text transform={`rotate(-32 ${cx} ${margin.top + plotH + 14})`} x={cx} y={margin.top + plotH + 14} textAnchor="end" fontSize={10.5} fill={SECONDARY}>
                  {truncate(fmt(row[xKey]), 14)}
                </text>
              )}
              <rect
                x={margin.left + ri * groupW}
                y={margin.top}
                width={groupW}
                height={plotH}
                fill="transparent"
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setTip({
                    x: e.clientX - box.left,
                    y: margin.top + 4,
                    title: fmt(row[xKey]),
                    lines: series.map((s, si) => ({ label: s, value: fmt(row[s]), color: SERIES[si % SERIES.length] })),
                  });
                }}
                onMouseLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
      {tip && <ChartTooltip tip={tip} width={width} />}
      </div>
    </div>
  );
}

// ── line / area — trends over an ordered axis ───────────────────────────────
function LineArea({ block, xKey, series, area, expanded }: { block: LumenVizBlock; xKey: string; series: string[]; area: boolean; expanded: boolean }) {
  const { ref, width } = useWidth();
  const [tip, setTip] = useState<{ i: number; x: number } | null>(null);

  const rows = useMemo(() => block.rows.slice(0, 80), [block.rows]);
  const height = expanded ? 340 : 264;
  const margin = { top: 12, right: 16, bottom: 40, left: 46 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;

  const values = rows.flatMap((r) => series.map((s) => num(r[s])));
  const scale = niceScale(Math.min(0, ...values), Math.max(...values, 1));
  const sx = (i: number) => margin.left + (i / Math.max(rows.length - 1, 1)) * plotW;
  const sy = (v: number) => margin.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const labelIdx = Array.from(new Set([0, Math.round((rows.length - 1) / 3), Math.round((2 * (rows.length - 1)) / 3), rows.length - 1].filter((i) => i >= 0)));

  return (
    <div ref={ref} className="w-full">
      <Legend series={series} />
      <div className="relative">
      <svg width={width} height={height} role="img" aria-label={block.title || "Line chart"}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={margin.left} y1={sy(t)} x2={width - margin.right} y2={sy(t)} stroke={GRID} />
            <text x={margin.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10.5} fill={MUTED}>
              {compact(t)}
            </text>
          </g>
        ))}
        {series.map((name, si) => {
          const pts = rows.map((r, i) => [sx(i), sy(num(r[name]))] as const);
          const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
          const color = SERIES[si % SERIES.length];
          return (
            <g key={name}>
              {area && <polygon points={`${pts[0][0]},${sy(scale.min)} ${line} ${pts[pts.length - 1][0]},${sy(scale.min)}`} fill={color} opacity={0.1} />}
              <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* end marker with a surface ring so it stays legible over the line */}
              <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
            </g>
          );
        })}
        {labelIdx.map((i) => (
          <text key={i} x={sx(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"} fontSize={10.5} fill={SECONDARY}>
            {truncate(fmt(rows[i][xKey]), 16)}
          </text>
        ))}
        {tip && (
          <line x1={sx(tip.i)} y1={margin.top} x2={sx(tip.i)} y2={margin.top + plotH} stroke={AXIS} />
        )}
        {tip && series.map((name, si) => (
          <circle key={name} cx={sx(tip.i)} cy={sy(num(rows[tip.i][name]))} r={4} fill={SERIES[si % SERIES.length]} stroke={SURFACE} strokeWidth={2} />
        ))}
        <rect
          x={margin.left}
          y={margin.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onMouseMove={(e) => {
            const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const rel = e.clientX - box.left - margin.left;
            const i = Math.max(0, Math.min(rows.length - 1, Math.round((rel / plotW) * (rows.length - 1))));
            setTip({ i, x: sx(i) });
          }}
          onMouseLeave={() => setTip(null)}
        />
      </svg>
      {tip && (
        <ChartTooltip
          tip={{ x: tip.x, y: margin.top + 4, title: fmt(rows[tip.i][xKey]), lines: series.map((s, si) => ({ label: s, value: fmt(rows[tip.i][s]), color: SERIES[si % SERIES.length] })) }}
          width={width}
        />
      )}
      </div>
    </div>
  );
}

// ── donut — a few parts of a whole ──────────────────────────────────────────
function Donut({ block, xKey, valueKey }: { block: LumenVizBlock; xKey: string; valueKey: string }) {
  const sorted = block.rows
    .map((r) => ({ label: fmt(r[xKey]), value: Math.max(0, num(r[valueKey])) }))
    .sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, 7);
  const restValue = sorted.slice(7).reduce((s, r) => s + r.value, 0);
  const slices = restValue > 0 ? [...head, { label: "Other", value: restValue }] : head;
  const total = slices.reduce((s, r) => s + r.value, 0) || 1;

  let start = -90;
  const arcs = slices.map((s, i) => {
    const deg = (s.value / total) * 360;
    const arc = { ...s, start, end: start + deg, color: SERIES[i % SERIES.length] };
    start += deg;
    return arc;
  });
  const arc = (a0: number, a1: number) => {
    const r = 86;
    const rad = (d: number) => (Math.PI / 180) * d;
    const x0 = 100 + r * Math.cos(rad(a0));
    const y0 = 100 + r * Math.sin(rad(a0));
    const x1 = 100 + r * Math.cos(rad(a1));
    const y1 = 100 + r * Math.sin(rad(a1));
    return `M 100 100 L ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1} Z`;
  };

  return (
    <div className="grid items-center gap-4 sm:grid-cols-[200px_1fr]">
      <svg viewBox="0 0 200 200" className="mx-auto h-48 w-48" role="img" aria-label={block.title || "Pie chart"}>
        {arcs.map((a, i) => (
          <path key={i} d={arc(a.start, a.end)} fill={a.color} stroke={SURFACE} strokeWidth={2}>
            <title>{`${a.label}: ${fmt(a.value)} (${Math.round((a.value / total) * 100)}%)`}</title>
          </path>
        ))}
        <circle cx={100} cy={100} r={52} fill={SURFACE} />
        <text x={100} y={96} textAnchor="middle" fontSize={22} fontWeight={700} fill={INK}>
          {compact(total)}
        </text>
        <text x={100} y={114} textAnchor="middle" fontSize={11} fill={MUTED}>
          Total
        </text>
      </svg>
      <div className="space-y-1.5">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: a.color }} />
            <span className="min-w-0 flex-1 truncate text-slate-600">{a.label}</span>
            <span className="tabular-nums text-slate-500">{compact(a.value)}</span>
            <span className="w-10 text-right font-semibold tabular-nums text-slate-800">{Math.round((a.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── chart dispatcher ────────────────────────────────────────────────────────
function ChartBody({ block, expanded }: { block: LumenVizBlock; expanded: boolean }) {
  const xKey = block.x && block.columns.includes(block.x) ? block.x : block.columns[0];
  const series = seriesFor(block, xKey);
  if (!xKey || !series.length) return <Empty msg="Nothing numeric to chart." />;

  if (block.as === "pie") return <Donut block={block} xKey={xKey} valueKey={series[0]} />;
  if (block.as === "line" || block.as === "area") {
    if (block.rows.length < 2) return <Empty msg="Need at least two points to plot a line." />;
    return <LineArea block={block} xKey={xKey} series={series.slice(0, 4)} area={block.as === "area"} expanded={expanded} />;
  }
  // bar: single series reads best as sorted horizontal bars (handles many / long
  // labels); multiple series stay as grouped vertical columns.
  if (series.length === 1) return <HorizontalBars block={block} xKey={xKey} valueKey={series[0]} expanded={expanded} />;
  return <Columns block={block} xKey={xKey} series={series.slice(0, 4)} expanded={expanded} />;
}

// ── table ───────────────────────────────────────────────────────────────────
function TableBlock({ block, expanded = false }: { block: LumenVizBlock; expanded?: boolean }) {
  const visibleRows = useMemo(() => block.rows.slice(0, 250), [block.rows]);
  const numericCol = useMemo(() => {
    const sample = block.rows[0] ?? {};
    return Object.fromEntries(block.columns.map((c) => [c, isNumeric(sample[c])]));
  }, [block.columns, block.rows]);

  return (
    <div>
      <div className={`overflow-auto rounded-lg ring-1 ring-slate-200 ${expanded ? "max-h-[calc(100vh-16rem)]" : "max-h-96"}`}>
        <table className={`min-w-full border-collapse text-left ${expanded ? "text-sm" : "text-[13px]"}`}>
          <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
            <tr>
              {block.columns.map((col) => (
                <th
                  key={col}
                  className={`whitespace-nowrap border-b border-slate-200 font-semibold ${expanded ? "px-4 py-3" : "px-3 py-2.5"} ${numericCol[col] ? "text-right" : ""}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className="odd:bg-white even:bg-slate-50 hover:bg-brand-50/50">
                {block.columns.map((col) => (
                  <td
                    key={col}
                    className={`border-b border-slate-100 ${expanded ? "px-4 py-2.5" : "px-3 py-2"} ${numericCol[col] ? "text-right tabular-nums text-slate-800" : "text-slate-700"}`}
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
          {block.rowCount.toLocaleString("en-GB")} row{block.rowCount === 1 ? "" : "s"}
          {visibleRows.length < block.rows.length ? `, showing ${visibleRows.length}` : ""}
        </span>
        <CopyTableButton columns={block.columns} rows={block.rows} />
      </div>
    </div>
  );
}

export function LumenVisualization({ block, expanded = false }: { block: LumenVizBlock; expanded?: boolean }) {
  if (!block.rows.length) {
    return <div className="rounded-xl bg-white p-3 text-sm text-slate-400 ring-1 ring-slate-200">No data returned.</div>;
  }
  const isTable = block.kind === "table" || block.as === "table";

  return (
    <div className={`rounded-xl bg-white text-slate-800 ring-1 ring-slate-200 ${expanded ? "p-4 text-base" : "p-3 text-sm"}`}>
      {block.title && <p className={`font-semibold text-slate-900 ${expanded ? "mb-4 text-base" : "mb-3 text-sm"}`}>{block.title}</p>}
      {isTable ? (
        <TableBlock block={block} expanded={expanded} />
      ) : (
        <>
          <ChartBody block={block} expanded={expanded} />
          <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-slate-100 pt-2 text-xs text-slate-400">
            <span>
              {block.rowCount.toLocaleString("en-GB")} row{block.rowCount === 1 ? "" : "s"}
            </span>
            <CopyTableButton columns={block.columns} rows={block.rows} label="Copy data" />
          </div>
        </>
      )}
    </div>
  );
}
