"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { chainKey } from "@/lib/chains";
import { isCustomerActive } from "@/lib/customer-activity";
import type { SalesInsights } from "@/lib/sales-analytics";
import type { Restaurant } from "@/lib/types";

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}
function kgFmt(n: number): string {
  return `${Math.round(n).toLocaleString("en-GB")} kg`;
}
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Row { name: string; code?: string; value: string }
interface Option { key: string; label: string; rows: (d: SalesInsights) => Row[] }

const topN = <T,>(arr: T[], val: (x: T) => number, n: number) => [...arr].sort((a, b) => val(b) - val(a)).slice(0, n);

const OPTIONS: Option[] = [
  { key: "top_customers", label: "Top customers · £ (30d)", rows: (d) => topN(d.perCustomer, (c) => c.sales, 5).map((c) => ({ name: c.name, code: c.code, value: gbp(c.sales) })) },
  { key: "top_groups", label: "Top groups · £ (30d)", rows: (d) => {
    const g = new Map<string, { name: string; sales: number }>();
    for (const c of d.perCustomer) { const k = chainKey(c.name); const e = g.get(k) ?? { name: c.name, sales: 0 }; e.sales += c.sales; g.set(k, e); }
    return topN(Array.from(g.values()), (x) => x.sales, 5).map((x) => ({ name: x.name, value: gbp(x.sales) }));
  } },
  { key: "decreasing", label: "Biggest £ drop (30d)", rows: (d) => {
    // From the prev-window list joined with current sales, so a customer who
    // dropped to £0 (the biggest drop) still shows — matches the full page.
    const curByCode = new Map(d.perCustomer.map((c) => [c.code, c]));
    const drops = d.perCustomerPrev.map((p) => {
      const cur = curByCode.get(p.code);
      return { name: cur?.name ?? p.name, code: p.code, drop: p.prevSales - (cur?.sales ?? 0) };
    }).filter((c) => c.drop > 0);
    return topN(drops, (c) => c.drop, 5).map((c) => ({ name: c.name, code: c.code, value: `−${gbp(c.drop)}` }));
  } },
  { key: "products_value", label: "Top products · £ (30d)", rows: (d) => topN(d.productsTop, (p) => p.sales, 5).map((p) => ({ name: p.description, value: gbp(p.sales) })) },
  { key: "products_kg", label: "Top products · kg (30d)", rows: (d) => topN(d.productsTop, (p) => p.kg, 5).map((p) => ({ name: p.description, value: kgFmt(p.kg) })) },
  { key: "fillings", label: "Top fillings · kg (30d)", rows: (d) => d.fillingsTopKg.slice(0, 5).map((p) => ({ name: p.description, value: kgFmt(p.kg) })) },
  { key: "segments", label: "Segments · £ (30d)", rows: (d) => d.segments30.slice(0, 5).map((s) => ({ name: s.segment, value: gbp(s.sales) })) },
  { key: "attention", label: "Needs attention", rows: (d) => d.attention.slice(0, 5).map((a) => ({ name: a.name, code: a.code, value: `${a.daysSinceLast}d` })) },
  { key: "on_stop", label: "On stop (10d)", rows: (d) => d.onStopNew.slice(0, 5).map((c) => ({ name: c.name, code: c.code, value: "on stop" })) },
  { key: "samples", label: "Samples sent (recent)", rows: (d) => {
    // samples10 is line-level — dedupe to one row per (recipient, day).
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const s of d.samples10) {
      const k = `${s.custCode}|${s.name}|${s.date ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name: s.name, code: s.isProspect ? undefined : s.custCode, value: s.date ?? "" });
      if (out.length >= 5) break;
    }
    return out;
  } },
];
const OPTION_BY_KEY = new Map(OPTIONS.map((o) => [o.key, o]));

export function InsightsHighlights({ scopeCodes, repName = null, ready = true }: {
  scopeCodes: string[] | null;
  /** Viewed rep's display name — lets the API include the rep's prospect samples. */
  repName?: string | null;
  /** False while the caller's scope is still loading — don't fetch an empty scope. */
  ready?: boolean;
}) {
  const { allRestaurants } = useRestaurants();
  const { me } = useRep();
  const [data, setData] = useState<SalesInsights | null>(null);
  const [loading, setLoading] = useState(true);
  // Key on scope CONTENT so the 2-min store refresh doesn't re-query Power BI.
  const scopeKey = scopeCodes === null ? "*" : [...scopeCodes].sort().join(",");

  // Which two metrics the tiles show (persisted per rep). Lifted here so the
  // fetch requests ONLY those two + the attention badge from Power BI, instead
  // of the full ~14-query Insights computation the dashboard doesn't need.
  const repKey = me?.id ?? "anon";
  const [tileKeys, setTileKeys] = useState<[string, string]>(["top_customers", "products_value"]);
  useEffect(() => {
    const read = (idx: number, dflt: string) => {
      try {
        const s = localStorage.getItem(`ltp-insight-tile-${idx}-${repKey}`);
        return s && OPTION_BY_KEY.has(s) ? s : dflt;
      } catch {
        return dflt;
      }
    };
    setTileKeys([read(0, "top_customers"), read(1, "products_value")]);
  }, [repKey]);
  const setTile = (idx: 0 | 1, k: string) => {
    setTileKeys((prev) => (idx === 0 ? [k, prev[1]] : [prev[0], k]));
    try { localStorage.setItem(`ltp-insight-tile-${idx}-${repKey}`, k); } catch { /* ignore */ }
  };
  const metricsKey = Array.from(new Set([...tileKeys, "attention"])).sort().join(",");

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    const metrics = Array.from(new Set([...tileKeys, "attention"]));
    fetch("/api/insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes: scopeCodes, repName, metrics }) })
      .then((r) => r.json())
      .then((d: SalesInsights) => { if (alive) { if (d.configured) setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, repName, ready, metricsKey]);

  const codeToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRestaurants) if (r.customerAccountCode) m.set(r.customerAccountCode, r.id);
    return m;
  }, [allRestaurants]);

  // Exclude already-inactive (Closed/On Stop) customers from the "off their
  // ordering pattern" attention list — they're handled under inactivity — so the
  // dashboard badge/tile matches the full Insights page.
  const dataForTiles = useMemo<SalesInsights | null>(() => {
    if (!data) return null;
    const byCode = new Map<string, Restaurant>();
    for (const r of allRestaurants) if (r.customerAccountCode) byCode.set(r.customerAccountCode, r);
    const attention = data.attention.filter((a) => {
      const r = byCode.get(a.code);
      return !r || isCustomerActive(r);
    });
    return { ...data, attention };
  }, [data, allRestaurants]);

  const attention = dataForTiles?.attention.length ?? 0;

  return (
    <div className="mt-6 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-slate-900">Sales &amp; product insights</h2>
        <Link href="/insights" className="shrink-0 text-sm font-semibold text-brand-600 hover:underline">Open full page →</Link>
      </div>
      {attention > 0 && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800 ring-1 ring-amber-200">
          <b>{attention}</b> customer{attention === 1 ? "" : "s"} off their usual ordering pattern
        </div>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <InsightTile data={dataForTiles} loading={loading} codeToId={codeToId} value={tileKeys[0]} onChange={(k) => setTile(0, k)} />
        <InsightTile data={dataForTiles} loading={loading} codeToId={codeToId} value={tileKeys[1]} onChange={(k) => setTile(1, k)} />
      </div>
    </div>
  );
}

function InsightTile({ data, loading, codeToId, value, onChange }: {
  data: SalesInsights | null; loading: boolean; codeToId: Map<string, string>; value: string; onChange: (k: string) => void;
}) {
  const opt = OPTION_BY_KEY.get(value) ?? OPTIONS[0];
  const rows = data ? opt.rows(data) : [];

  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-100">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mb-2 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
        {OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {loading ? (
        <div className="flex h-24 items-center justify-center"><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" /></div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-400">No data.</p>
      ) : (
        <ol className="space-y-1 text-sm">
          {rows.map((r, i) => {
            const id = r.code ? codeToId.get(r.code) : undefined;
            return (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {id ? <Link href={`/restaurants/${id}?from=dashboard`} className="text-brand-700 hover:underline">{titleCase(r.name)}</Link> : <span className="text-slate-800">{titleCase(r.name)}</span>}
                </span>
                <span className="shrink-0 whitespace-nowrap text-slate-600 [font-variant-numeric:tabular-nums]">{r.value}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
