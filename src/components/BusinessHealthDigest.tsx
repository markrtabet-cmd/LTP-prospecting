"use client";

import { useEffect, useState } from "react";
import { Search, Sparkles, TrendingUp } from "lucide-react";

interface BusinessHealthResponse {
  configured: boolean;
  computed?: boolean;
  computedAt?: string;
  summary1?: string;
  summary2?: string;
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
  const [state, setState] = useState<{ status: "loading" | "ready" | "hidden"; data: BusinessHealthResponse | null }>({
    status: "loading",
    data: null,
  });

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

  if (state.status !== "ready" || !state.data?.summary1) return null;
  const { summary1, summary2, computedAt } = state.data;

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
            <p className="text-xs text-slate-400">Small, specific things the sales data suggests</p>
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
          points={splitPoints(summary1)}
          marker="bg-brand-400"
        />
        <DigestCard
          icon={<TrendingUp size={14} />}
          chip="bg-blue-50 text-blue-600"
          title="What's shifting"
          subtitle="Small movements worth knowing"
          points={splitPoints(summary2 ?? "")}
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
  points: string[];
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
              <span className="leading-snug">{p}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
