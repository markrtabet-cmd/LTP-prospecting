"use client";

import { useEffect, useState } from "react";
import { useRep } from "@/lib/rep";

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// "Power BI updated X ago" — the source dataset's own last refresh time, so
// staff can see how fresh the sales figures are. Re-checked every 10 min.
function LastUpdatedBadge() {
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/powerbi/last-refresh")
        .then((r) => r.json())
        .then((d: { refreshedAt?: string | null }) => { if (alive) setRefreshedAt(d.refreshedAt ?? null); })
        .catch(() => {});
    load();
    const iv = setInterval(() => { load(); setTick((n) => n + 1); }, 10 * 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const rel = relativeTime(refreshedAt);
  void tick; // re-render to keep the relative label current
  if (!rel) return null;
  return (
    <span
      className="hidden items-center gap-1.5 text-xs text-slate-400 sm:inline-flex"
      title={refreshedAt ? new Date(refreshedAt).toLocaleString("en-GB") : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      Power BI updated {rel}
    </span>
  );
}

// Site-wide rep switcher for admins/developers: mirrors the calendar's per-rep
// switch but scopes the WHOLE site (dashboard, customers, leads, insights,
// activity, map) — or the whole company. Read-only view scoping.
function AdminViewSwitcher() {
  const { seesEverything, salesReps, viewRepId, setViewRepId } = useRep();
  if (!seesEverything) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="hidden sm:inline">Viewing</span>
      <select
        value={viewRepId ?? ""}
        onChange={(e) => setViewRepId(e.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 outline-none focus:border-brand-500"
      >
        <option value="">Whole company</option>
        {salesReps.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
    </label>
  );
}

export function TopBar() {
  return (
    <div className="flex h-12 shrink-0 items-center justify-end gap-4 border-b border-slate-200 bg-white px-6">
      <LastUpdatedBadge />
      <AdminViewSwitcher />
    </div>
  );
}
