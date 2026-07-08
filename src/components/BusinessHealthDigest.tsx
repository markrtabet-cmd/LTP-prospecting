"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Sparkles, TrendingUp } from "lucide-react";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
import { isLondon } from "@/lib/locations";
import { normalizeName } from "@/lib/visits/match";
import type { AnomalySignal, OpportunitySignal } from "@/lib/business-health";
import type { Rep } from "@/lib/types";

// An insight line, optionally linked to the customer's profile it's about.
type Point = { text: string; href?: string };

interface BusinessHealthResponse {
  configured: boolean;
  computed?: boolean;
  computedAt?: string;
  summary1?: string;
  summary2?: string;
  anomalies?: AnomalySignal[];
  opportunities?: OpportunitySignal[];
}

// Does a Power BI account-manager spelling (e.g. "STEFANO") belong to this rep?
// Same first-name/substring tolerance the customer matcher uses.
function repMatchesSalesRep(rep: Rep, salesRep: string | null | undefined): boolean {
  if (!salesRep) return false;
  const norm = normalizeName(salesRep);
  if (!norm) return false;
  for (const c of [rep.name, ...(rep.aliases ?? [])]) {
    const cn = normalizeName(c);
    if (cn && (cn === norm || norm.includes(cn) || cn.includes(norm))) return true;
  }
  return false;
}

function agoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function BusinessHealthDigest() {
  const { me, reps, seesEverything } = useRep();
  const { allRestaurants, londonOnly } = useRestaurants();
  const [state, setState] = useState<{ status: "loading" | "ready" | "hidden"; data: BusinessHealthResponse | null }>({
    status: "loading",
    data: null,
  });

  // Resolve a signal to the customer profile it's about. Built from the FULL
  // venue list (not the London-filtered one) so we can both link every matched
  // customer AND tell a confirmed non-London customer apart from one that simply
  // isn't matched to a venue record. Joins on the Power BI account code first
  // (reliable), then the customer name.
  const resolve = useMemo(() => {
    const byCode = new Map<string, { id: string; london: boolean }>();
    const byName = new Map<string, { id: string; london: boolean }>();
    for (const r of allRestaurants) {
      const rec = { id: r.id, london: isLondon(r.borough) };
      if (r.customerAccountCode && !byCode.has(r.customerAccountCode)) byCode.set(r.customerAccountCode, rec);
      const n = normalizeName(r.name);
      if (n && !byName.has(n)) byName.set(n, rec);
    }
    const lookup = (code?: string | null, name?: string | null) =>
      (code ? byCode.get(code) : undefined) ?? (name ? byName.get(normalizeName(name)) : undefined);
    return {
      href: (code?: string | null, name?: string | null): string | undefined => {
        const m = lookup(code, name);
        return m ? `/restaurants/${m.id}` : undefined;
      },
      // Under London-only, hide a per-customer signal ONLY when we can confirm
      // it's a non-London customer. Company-wide signals and unmatched customers
      // stay visible (we never drop an insight just because it isn't clickable).
      inScope: (code?: string | null, name?: string | null): boolean => {
        if (!londonOnly) return true;
        if (!code && !name) return true;
        const m = lookup(code, name);
        return m ? m.london : true;
      },
    };
  }, [allRestaurants, londonOnly]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/business-health")
      .then((r) => r.json())
      .then((d: BusinessHealthResponse) => {
        if (cancelled) return;
        if (!d.configured || !d.computed) setState({ status: "hidden", data: null });
        else setState({ status: "ready", data: d });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "hidden", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rep = useMemo(
    () => (me ? reps.find((r) => r.id === me.id) ?? null : null),
    [me, reps],
  );

  // Every insight is rendered from the STRUCTURED signals (each has a customer
  // ref), so they all link to a profile — admins see the whole team's, a rep
  // sees only their own accounts (matched on the Power BI account manager).
  // Under London-only, per-account signals that don't resolve to a (London)
  // restaurant are dropped so non-London customers never show.
  const { points1, points2 } = useMemo(() => {
    const data = state.data;
    if (!data) return { points1: [] as Point[], points2: [] as Point[] };
    const mine = (salesRep?: string | null) => seesEverything || (rep ? repMatchesSalesRep(rep, salesRep) : false);
    const opps = (data.opportunities ?? []).filter((o) => mine(o.salesRep) && resolve.inScope(o.custCode, o.customerName));
    const anoms = (data.anomalies ?? []).filter((a) => mine(a.salesRep) && resolve.inScope(a.custCode, a.customerName));
    return {
      points1: opps.slice(0, 8).map((o) => ({ text: `${o.headline} ${o.detail}`.trim(), href: resolve.href(o.custCode, o.customerName) })),
      points2: anoms.slice(0, 8).map((a) => ({ text: `${a.headline} ${a.detail}`.trim(), href: resolve.href(a.custCode, a.customerName) })),
    };
  }, [state.data, seesEverything, rep, resolve]);

  // Show the section only once computed and there's actually something to flag.
  if (state.status !== "ready" || !state.data) return null;
  if (points1.length === 0 && points2.length === 0) return null;
  const { computedAt } = state.data;

  return (
    <div className="anim-rise mt-6" style={{ "--rise-delay": "580ms" } as React.CSSProperties}>
      {/* Section header — signals these are AI-written, from the sales data */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <Sparkles size={16} />
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">AI insights</h2>
            <p className="text-xs text-slate-400">
              {seesEverything ? "Across the whole team's sales data" : "Small, specific things about your accounts"}
            </p>
          </div>
        </div>
        {computedAt && <span className="shrink-0 text-xs text-slate-400">Updated {agoLabel(computedAt)}</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <DigestCard
          icon={<Search size={14} />}
          chip="bg-brand-50 text-brand-600"
          title="Worth a closer look"
          subtitle="Accounts to check in on"
          points={points1}
          marker="bg-brand-400"
        />
        <DigestCard
          icon={<TrendingUp size={14} />}
          chip="bg-blue-50 text-blue-600"
          title="What's shifting"
          subtitle="Small movements worth knowing"
          points={points2}
          marker="bg-blue-400"
        />
      </div>
    </div>
  );
}

function DigestCard({
  icon,
  chip,
  title,
  subtitle,
  points,
  marker,
}: {
  icon: React.ReactNode;
  chip: string;
  title: string;
  subtitle: string;
  points: Point[];
  marker: string;
}) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${chip}`}>{icon}</span>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <p className="mb-3 mt-0.5 pl-8 text-xs text-slate-400">{subtitle}</p>
      {points.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing to flag this week.</p>
      ) : (
        <ul className="space-y-0.5">
          {points.map((p, i) => (
            <li key={i} className="flex gap-2.5 rounded-lg px-1.5 py-1.5 text-sm text-slate-700 transition-colors duration-150 hover:bg-slate-50">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${marker}`} />
              {p.href ? (
                <Link href={p.href} className="leading-snug hover:text-brand-700 hover:underline">
                  {p.text}
                </Link>
              ) : (
                <span className="leading-snug">{p.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
