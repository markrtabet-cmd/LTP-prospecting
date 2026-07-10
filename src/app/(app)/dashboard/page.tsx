"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Wrench } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { TodaysAgenda } from "@/components/TodaysAgenda";
import { InsightsHighlights } from "@/components/InsightsHighlights";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { venuesForRep } from "@/lib/visits/schedule";
import type { DashboardKpis } from "@/lib/sales-analytics";
import {
  isActiveProspectForAnyone,
  isActiveProspectForRep,
} from "@/lib/ownership";
import { isNewOpening } from "@/lib/types";
import { isNewCustomer30d } from "@/lib/customer-activity";
import { isRelevantSector } from "@/lib/sectors";
import type { UnmatchedCustomer } from "@/lib/customer-fix";

export default function DashboardPage() {
  const { restaurants, loading: venuesLoading, londonOnly } = useRestaurants();
  const { me, reps, role, seesEverything, loading: repLoading } = useRep();
  const loading = venuesLoading || repLoading;

  // Admins and developers see COMPANY-WIDE totals; a rep sees only their own
  // accounts and prospects. The signed-in rep's roster entry supplies the
  // Power BI aliases that decide which customers are theirs.
  const rep = useMemo(
    () => (me ? reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null),
    [me, reps],
  );

  // For reps: their own customers. For admins/devs: every customer.
  const myCustomers = useMemo(() => {
    if (seesEverything) return restaurants.filter((r) => r.existingCustomer);
    return rep ? venuesForRep(restaurants, rep, reps).filter((r) => r.existingCustomer) : [];
  }, [restaurants, rep, reps, seesEverything]);

  const totalCustomers = myCustomers.length;
  const newCustomers = useMemo(() => myCustomers.filter((r) => isNewCustomer30d(r)).length, [myCustomers]);

  const activeProspects = useMemo(() => {
    if (seesEverything) return restaurants.filter(isActiveProspectForAnyone).length;
    return me ? restaurants.filter((r) => isActiveProspectForRep(r, me.id)).length : 0;
  }, [restaurants, me, seesEverything]);

  // New openings are pipeline-wide (not rep-scoped) — a shared signal of fresh
  // venues to chase, counted the same way the Leads "New openings" filter does.
  const newOpenings = useMemo(() => restaurants.filter(isNewOpening).length, [restaurants]);

  // Sales KPIs from Power BI — scoped to this viewer's own customer account codes
  // (company-wide for admins/devs). Fetched client-side so they track Power BI.
  const scopeCodes = useMemo<string[] | null>(
    () => (seesEverything ? null : myCustomers.map((c) => c.customerAccountCode).filter((x): x is string => !!x)),
    [seesEverything, myCustomers],
  );
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [kpiLoading, setKpiLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setKpiLoading(true);
    fetch("/api/dashboard/kpis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes: scopeCodes }) })
      .then((r) => r.json())
      .then((d: DashboardKpis) => { if (alive) { setKpis(d.configured ? d : null); setKpiLoading(false); } })
      .catch(() => { if (alive) setKpiLoading(false); });
    return () => { alive = false; };
  }, [scopeCodes]);

  const scoped = !seesEverything;

  // Admins: how many Power BI customers the sync couldn't place on the map yet.
  const [fixCount, setFixCount] = useState<number | null>(null);
  useEffect(() => {
    if (!seesEverything) return;
    let alive = true;
    fetch("/api/customers-to-fix")
      .then((r) => r.json())
      .then((d: { ok: boolean; items?: UnmatchedCustomer[] }) => {
        if (!alive || !d.ok) return;
        // Match the fix page's default view: only active customers in a sector a
        // rep actually serves. Dormant / off-target gaps aren't worth flagging here.
        setFixCount((d.items ?? []).filter((i) => i.active !== false && isRelevantSector(i.sector)).length);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [seesEverything]);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`${scoped ? "Your" : "The team's"} ${londonOnly ? "London" : "UK"} restaurant pipeline at a glance`}
        action={
          <Link
            href="/add"
            className="rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-[background-color,transform] duration-150 hover:bg-brand-600 active:scale-[0.98] active:bg-brand-700"
          >
            + Add venue
          </Link>
        }
      />

      {/* KPI cards — row 1: activity; row 2: sales figures from Power BI. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Active customers · 30d" accent="blue" loading={kpiLoading}
          value={kpis ? kpis.activeCustomers.last30.toLocaleString() : "…"}
          comparisons={kpis ? [
            { label: "vs prev 30 days", delta: pctDelta(kpis.activeCustomers.last30, kpis.activeCustomers.prev30) },
            { label: "vs same period last yr", delta: pctDelta(kpis.activeCustomers.last30, kpis.activeCustomers.lastYear30) },
          ] : undefined}
        />
        <KpiCard label="New customers" value={loading ? "…" : newCustomers.toLocaleString()} accent="green" sub="in the last 30 days" href="/customers?new=1" />
        <KpiCard label="Active prospects" value={loading ? "…" : activeProspects.toLocaleString()} accent="amber" sub={scoped ? "yours: claimed or in contact" : "claimed or in contact"} href="/leads" />
        <KpiCard label="New openings" value={loading ? "…" : newOpenings.toLocaleString()} accent="purple" sub="newly opened or opening soon" href="/leads?openings=1" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Sales · 30d" accent="blue" loading={kpiLoading}
          value={kpis ? gbpCompact(kpis.salesValue.last30) : "…"}
          comparisons={kpis ? [
            { label: "vs prev 30 days", delta: pctDelta(kpis.salesValue.last30, kpis.salesValue.prev30) },
            { label: "vs same period last yr", delta: pctDelta(kpis.salesValue.last30, kpis.salesValue.lastYear30) },
          ] : undefined}
        />
        <KpiCard label="Today's sales" accent="green" loading={kpiLoading} value={kpis ? gbpCompact(kpis.todaySales) : "…"} sub="so far today" />
        <KpiCard
          label={`Sales · FY ${kpis?.fyLabel.prev ?? ""}`.trim()} accent="indigo" loading={kpiLoading}
          value={kpis ? gbpCompact(kpis.fyPrev) : "…"}
          comparisons={kpis ? [{ label: `projected FY ${kpis.fyLabel.current}`, text: gbpCompact(kpis.fyProjection), delta: pctDelta(kpis.fyProjection, kpis.fyPrev) }] : undefined}
        />
        <KpiCard label={`YTD · FY ${kpis?.fyLabel.current ?? ""}`.trim()} accent="amber" loading={kpiLoading} value={kpis ? gbpCompact(kpis.fyToDate) : "…"} sub="from 1 July" />
      </div>

      {seesEverything && fixCount != null && fixCount > 0 && (
        <Link
          href="/fix-customers"
          className="mt-4 flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm ring-1 ring-amber-200 transition hover:bg-amber-100"
        >
          <Wrench className="h-5 w-5 shrink-0 text-amber-600" />
          <span className="flex-1 text-amber-900">
            <b>{fixCount.toLocaleString()}</b> Power BI {fixCount === 1 ? "customer isn't" : "customers aren't"} on the map yet — link or add {fixCount === 1 ? "it" : "them"} so reps can see {fixCount === 1 ? "it" : "them"}.
          </span>
          <span className="shrink-0 font-semibold text-amber-700">Review →</span>
        </Link>
      )}

      {/* Today's calendar — above the insights highlights. */}
      <div className="mt-6">
        <TodaysAgenda />
      </div>

      {/* Sales & product insights — attention count + two configurable tiles. */}
      <InsightsHighlights scopeCodes={scopeCodes} />
    </div>
  );
}

const ACCENT_BAR: Record<string, string> = {
  blue: "bg-blue-500", green: "bg-green-500", amber: "bg-amber-500", purple: "bg-purple-500", indigo: "bg-indigo-500",
};

function gbpCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `£${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `£${Math.round(n / 1000).toLocaleString("en-GB")}k`;
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

/** Fractional change of `a` vs `b` (null when there's no base to compare to). */
function pctDelta(a: number, b: number): number | null {
  return b > 0 ? (a - b) / b : null;
}

interface Comparison { label: string; delta?: number | null; text?: string }

function KpiCard({ label, value, sub, accent = "blue", loading, comparisons, href }: {
  label: string; value: string; sub?: string; accent?: string; loading?: boolean; comparisons?: Comparison[]; href?: string;
}) {
  const cls = `relative block overflow-hidden rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200${href ? " transition hover:ring-brand-300" : ""}`;
  const body = (
    <>
      <div className={`absolute inset-x-0 top-0 h-0.5 ${ACCENT_BAR[accent] ?? "bg-slate-400"}`} />
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900 [font-variant-numeric:tabular-nums]">{loading ? "…" : value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
      {comparisons && comparisons.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {comparisons.map((c, i) => {
            const up = (c.delta ?? 0) >= 0;
            return (
              <div key={i} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-500">{c.label}</span>
                <span className="flex items-center gap-1.5">
                  {c.text && <span className="font-medium text-slate-700">{c.text}</span>}
                  {c.delta != null && (
                    <span className={`font-semibold ${up ? "text-green-600" : "text-red-600"}`}>
                      {up ? "▲" : "▼"} {Math.abs(c.delta * 100).toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

