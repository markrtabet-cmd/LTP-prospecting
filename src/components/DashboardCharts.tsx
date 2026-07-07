"use client";

import { useMemo } from "react";
import { BarChart3, Filter } from "lucide-react";
import { funnelCounts } from "@/lib/mock-data";
import { getRegion, isLondon } from "@/lib/locations";
import type { Restaurant } from "@/lib/types";

// Two at-a-glance dashboard charts. Both are single-series magnitude views, so
// they use one brand hue (a light→dark sequential ramp on the funnel, uniform
// on the bars) — no categorical palette, text stays in slate ink. Plain HTML
// bars keep it dependency-free and responsive.

interface Row {
  label: string;
  value: number;
}

// brand-tinted sequential ramp, darkest = largest stage
const FUNNEL_RAMP = ["bg-brand-600", "bg-brand-500", "bg-brand-400", "bg-brand-300"];

function HBars({ rows, max, ramp }: { rows: Row[]; max: number; ramp?: string[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400">No data yet.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {rows.map((row, i) => {
        const pct = max > 0 && row.value > 0 ? Math.max(3, Math.round((row.value / max) * 100)) : 0;
        const color = ramp ? ramp[Math.min(i, ramp.length - 1)] : "bg-brand-500";
        return (
          <li
            key={row.label}
            className="flex items-center gap-3 text-sm"
            title={`${row.label}: ${row.value.toLocaleString()}`}
          >
            <span className="w-24 shrink-0 truncate text-slate-600">{row.label}</span>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-slate-700">
              {row.value.toLocaleString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ChartCard({
  icon,
  title,
  caption,
  delay,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="anim-rise rounded-xl bg-white p-5 shadow-sm"
      style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
    >
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">{title}</h2>
      </div>
      <p className="mb-4 text-xs text-slate-400">{caption}</p>
      {children}
    </div>
  );
}

export function DashboardCharts({
  restaurants,
  londonOnly,
}: {
  restaurants: Restaurant[];
  londonOnly: boolean;
}) {
  const funnel = useMemo<Row[]>(() => {
    const f = funnelCounts(restaurants);
    return [
      { label: "All venues", value: f.total },
      { label: "Best fits", value: f.recommended },
      { label: "Contacted", value: f.contacted },
      { label: "Customers", value: f.customers },
    ];
  }, [restaurants]);
  const funnelMax = funnel[0]?.value ?? 0;

  const areas = useMemo<Row[]>(() => {
    const openings = restaurants.filter(
      (r) => (r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") && !r.excluded,
    );
    const scoped = londonOnly ? openings.filter((r) => isLondon(r.borough)) : openings;
    const byArea = new Map<string, number>();
    for (const r of scoped) {
      const key = londonOnly ? r.borough : getRegion(r.borough, r.postcode);
      byArea.set(key, (byArea.get(key) ?? 0) + 1);
    }
    return Array.from(byArea.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [restaurants, londonOnly]);
  const areaMax = areas[0]?.value ?? 0;

  return (
    <div className="anim-rise mt-6 grid gap-4 md:grid-cols-2" style={{ "--rise-delay": "500ms" } as React.CSSProperties}>
      <ChartCard
        icon={<Filter size={16} className="text-brand-600" />}
        title="Pipeline at a glance"
        caption="How venues narrow from all leads down to paying customers"
        delay={500}
      >
        <HBars rows={funnel} max={funnelMax} ramp={FUNNEL_RAMP} />
      </ChartCard>

      <ChartCard
        icon={<BarChart3 size={16} className="text-brand-600" />}
        title={`New openings by ${londonOnly ? "borough" : "region"}`}
        caption="Where new restaurants are opening across your patch"
        delay={560}
      >
        <HBars rows={areas} max={areaMax} />
      </ChartCard>
    </div>
  );
}
