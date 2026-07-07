"use client";

import { useEffect, useState } from "react";
import { ListChecks, TrendingUp } from "lucide-react";

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
    <div className="anim-rise mt-6 grid gap-4 md:grid-cols-2" style={{ "--rise-delay": "530ms" } as React.CSSProperties}>
      <DigestCard
        icon={<ListChecks size={16} className="text-blue-600" />}
        title="Do this week"
        subtitle="Small, specific things worth a rep's time"
        points={splitPoints(summary1)}
        accent="blue"
      />
      <DigestCard
        icon={<TrendingUp size={16} className="text-brand-600" />}
        title="How the business is doing"
        subtitle="The bigger picture, at a glance"
        points={splitPoints(summary2 ?? "")}
        accent="brand"
      />
      {computedAt && (
        <p className="-mt-2 text-xs text-slate-400 md:col-span-2">Updated {agoLabel(computedAt)} · refreshes each week</p>
      )}
    </div>
  );
}

function DigestCard({
  icon,
  title,
  subtitle,
  points,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  points: string[];
  accent: "blue" | "brand";
}) {
  const dot = accent === "blue" ? "bg-blue-400" : "bg-brand-400";
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">{title}</h2>
      </div>
      <p className="mb-3 text-xs text-slate-400">{subtitle}</p>
      {points.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing notable this week.</p>
      ) : (
        <ul className="space-y-2">
          {points.map((p, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-700">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
