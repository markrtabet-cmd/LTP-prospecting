"use client";

// Compact multi-select: a button showing the count that opens a checkbox list.
// Uses native <details> so it closes on its own without click-outside wiring.
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (o: string, on: boolean) =>
    onChange(on ? [...selected, o] : selected.filter((x) => x !== o));

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
        {label}
        {selected.length > 0 && (
          <span className="rounded-full bg-brand-500 px-1.5 text-xs font-semibold text-white">{selected.length}</span>
        )}
        <span className="text-slate-400">▾</span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-60 overflow-y-auto rounded-lg bg-white p-2 shadow-lg ring-1 ring-slate-200">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
          {selected.length > 0 && (
            <button onClick={() => onChange([])} className="text-xs text-brand-600 hover:underline">
              Clear
            </button>
          )}
        </div>
        {options.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={selected.includes(o)} onChange={(e) => toggle(o, e.target.checked)} />
            <span className="truncate">{o}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
