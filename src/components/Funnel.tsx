interface FunnelStage {
  label: string;
  value: number;
}

// Simple horizontal funnel: each stage bar is scaled relative to the top stage.
export function Funnel({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div className="space-y-2">
      {stages.map((stage, i) => {
        const pct = Math.max((stage.value / max) * 100, 4);
        return (
          <div key={stage.label} className="flex items-center gap-3">
            <div className="w-48 shrink-0 text-sm text-slate-600">{stage.label}</div>
            <div className="flex-1">
              <div
                className="flex h-8 items-center justify-end rounded-md bg-gradient-to-r from-brand-500 to-brand-600 pr-2 text-sm font-medium text-white transition-all"
                style={{ width: `${pct}%`, opacity: 1 - i * 0.08 }}
              >
                {stage.value.toLocaleString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
