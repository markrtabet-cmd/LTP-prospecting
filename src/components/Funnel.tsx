"use client";

import { useEffect, useState } from "react";

interface FunnelStage {
  label: string;
  value: number;
}

// Horizontal funnel: solid crimson pills on a faint warm track, scaled
// relative to the top stage. Bars grow in on load (staggered per row),
// instantly for reduced-motion users.
export function Funnel({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(...stages.map((s) => s.value), 1);

  // Start bars at 0 only when motion is allowed, then grow to target.
  const [grown, setGrown] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="space-y-3">
      {stages.map((stage, i) => {
        const pct = Math.max((stage.value / max) * 100, 4);
        return (
          <div key={stage.label} className="flex items-center gap-4">
            <div className="w-48 shrink-0 text-[13px] font-medium text-slate-500">
              {stage.label}
            </div>
            {/* Faint warm track so partial bars read clearly */}
            <div className="h-10 flex-1 overflow-hidden rounded-full bg-brand-50">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-700 ease-out"
                style={{
                  width: grown ? `${pct}%` : "0%",
                  transitionDelay: `${i * 90}ms`,
                }}
              />
            </div>
            <div className="w-20 shrink-0 text-right text-sm font-semibold text-slate-900 [font-variant-numeric:tabular-nums]">
              {stage.value.toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
