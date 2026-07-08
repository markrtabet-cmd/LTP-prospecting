"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Sparkles, TrendingUp } from "lucide-react";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
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

/** Splits the AI's bullet-style text on newlines / "•" into separate lines —
 * the model is asked for short punchy points, not prose, so render it that way. */
function splitPoints(text: string): string[] {
  return text
    .split(/\n+|(?=•)/)
    .map((s) => s.replace(/^[•\-\s]+/, "").trim())
    .filter(Boolean);
}

export function BusinessHealthDigest() {
  const { me, reps, seesEverything } = useRep();
  const { restaurants } = useRestaurants();
  const [state, setState] = useState<{ status: "loading" | "ready" | "hidden"; data: BusinessHealthResponse | null }>({
    status: "loading",
    data: null,
  });

  // Resolve an insight to the customer profile it's about, so each line can link
  // to /restaurants/[id]. Structured signals join on the Power BI account code
  // (or name); the admins' free-text prose is matched by customer name.
  const resolve = useMemo(() => {
    const byCode = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const r of restaurants) {
      if (r.customerAccountCode) byCode.set(r.customerAccountCode, r.id);
      const n = normalizeName(r.name);
      if (n && !byName.has(n)) byName.set(n, r.id);
    }
    const href = (id: string | undefined) => (id ? `/restaurants/${id}` : undefined);
    return {
      bySignal: (code?: string | null, name?: string | null): string | undefined => {
        if (code && byCode.has(code)) return href(byCode.get(code));
        if (name) return href(byName.get(normalizeName(name)));
        return undefined;
      },
      // Best-effort: link a prose line if it clearly names one customer. Guarded
      // on name length so common short words don't create false links.
      byText: (text: string): string | undefined => {
        const lower = text.toLowerCase();
        for (const r of restaurants) {
          const nm = r.name.toLowerCase();
          if (nm.length >= 6 && lower.includes(nm)) return href(r.id);
        }
        return undefined;
      },
    };
  }, [restaurants]);

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

  // Admins/devs see the whole team's AI-written prose. A rep sees only the
  // signals for THEIR OWN accounts (matched on the Power BI account manager),
  // rendered straight from the structured data so nobody else's accounts leak
  // in.
  const { points1, points2 } = useMemo(() => {
    const data = state.data;
    if (!data) return { points1: [] as Point[], points2: [] as Point[] };
    if (seesEverything) {
      return {
        points1: splitPoints(data.summary1 ?? "").map((t) => ({ text: t, href: resolve.byText(t) })),
        points2: splitPoints(data.summary2 ?? "").map((t) => ({ text: t, href: resolve.byText(t) })),
      };
    }
    if (!rep) return { points1: [] as Point[], points2: [] as Point[] };
    const myOpps = (data.opportunities ?? []).filter((o) => repMatchesSalesRep(rep, o.salesRep));
    const myAnoms = (data.anomalies ?? []).filter((a) => repMatchesSalesRep(rep, a.salesRep));
    return {
      points1: myOpps.slice(0, 8).map((o) => ({ text: `${o.headline} ${o.detail}`.trim(), href: resolve.bySignal(null, o.customerName) })),
      points2: myAnoms.slice(0, 8).map((a) => ({ text: `${a.headline} ${a.detail}`.trim(), href: resolve.bySignal(a.custCode, a.customerName) })),
    };
  }, [state.data, seesEverything, rep, resolve]);

  // Admins hinge on the prose summary existing; reps hinge on the digest having
  // been computed at all (their points come from the structured signals).
  if (state.status !== "ready" || !state.data) return null;
  if (seesEverything && !state.data.summary1) return null;
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
