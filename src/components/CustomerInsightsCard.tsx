"use client";

import { useState } from "react";
import type { CustomerInsights } from "@/app/api/powerbi/customer-insights/route";
import type { InsightsState } from "@/hooks/useCustomerInsights";

// Desktop customer profile — the big "Sales" card: live Power BI headline stats,
// the last order, the last-12-months table (newest first) and last-3-months
// products. The account facts, contacts and customer-service outreach live in
// the sidebar's "Account & contact" card (both fed by the same lifted
// useCustomerInsights fetch). Customers see this instead of the prospecting
// lead-score breakdown, which is meaningless once they're a customer.

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
}

export function CustomerInsightsCard({ state }: { state: InsightsState }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Sales</h2>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          Live from Power BI
        </span>
      </div>

      {(state.status === "loading" || state.status === "idle") && (
        <div className="flex h-40 items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
        </div>
      )}

      {state.status === "unlinked" && (
        <div className="rounded-xl bg-slate-50 px-4 py-10 text-center">
          <p className="text-sm text-slate-500">No matching Power BI account found.</p>
          <p className="mt-1 text-xs text-slate-400">Check the customer name, postcode, or account code in Power BI.</p>
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-xl bg-amber-50 px-4 py-8 text-center">
          <p className="text-sm font-semibold text-amber-800">Couldn&apos;t load live Power BI data</p>
          {state.message && <p className="mt-1 break-words text-xs text-amber-700">{state.message.slice(0, 200)}</p>}
        </div>
      )}

      {state.status === "ready" && <Ready data={state.data} />}
    </div>
  );
}

function Ready({ data }: { data: CustomerInsights }) {
  const a = data.account;
  // Newest month first (the API returns oldest → newest); copy before reversing
  // so the shared data isn't mutated, and the totals below stay order-independent.
  const months = [...data.monthly].reverse();
  const products = data.products;
  const totalSales = months.reduce((s, m) => s + m.sales, 0);
  const totalKg = months.reduce((s, m) => s + m.kg, 0);
  const stale = data.diagnostics?.stale;
  const staleSince = data.diagnostics?.datasetRefreshedAt?.slice(0, 10) ?? data.diagnostics?.latestDatasetSale ?? null;

  return (
    <div className="space-y-6">
      {stale && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Power BI hasn&apos;t refreshed since {fmtDay(staleSince)} — these figures may be out of date.
        </div>
      )}

      {data.diagnostics?.warnings && data.diagnostics.warnings.length > 0 && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          Some Power BI data couldn&apos;t load: {data.diagnostics.warnings.join("; ")}
        </div>
      )}

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sales · 12 mo" value={gbp(totalSales)} />
        <Stat label="KG · 12 mo" value={Math.round(totalKg).toLocaleString("en-GB")} />
        <Stat label="Avg order" value={a?.adv != null ? gbp(a.adv) : "—"} />
        <LastSaleStat orderDate={a?.lastOrderDate ?? null} sampleDate={a?.lastSampleDate ?? null} />
      </div>

      {/* Exactly what the last order contained */}
      {data.lastOrder && (
        <div className="rounded-xl bg-slate-50 p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Last order · {fmtDay(data.lastOrder.date)}
            </p>
            {data.lastOrder.documentNos.length > 0 && (
              <span className="text-[11px] text-slate-400">
                {data.lastOrder.documentNos.length === 1 ? "Document" : "Documents"}{" "}
                {data.lastOrder.documentNos.join(", ")}
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <tbody>
              {data.lastOrder.lines.map((l) => (
                <tr key={`${l.code}-${l.description}`} className="border-t border-slate-200/60 text-slate-700 first:border-t-0">
                  <td className="py-1.5 pr-2">
                    <span className="block text-[13px] font-medium leading-snug">{titleCase(l.description)}</span>
                    {l.code && <span className="text-[10px] text-slate-400">{l.code}</span>}
                  </td>
                  <td className="py-1.5 text-right align-top text-slate-500">{Math.round(l.kg)} kg</td>
                  <td className="py-1.5 pl-3 text-right align-top">{gbp(l.sales)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 font-semibold text-slate-900">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right">{Math.round(data.lastOrder.kg)} kg</td>
                <td className="py-1.5 pl-3 text-right">{gbp(data.lastOrder.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* No itemised last order — say so explicitly rather than showing a
          silent gap (the "Last sale" stat above still shows the date). */}
      {!data.lastOrder && (
        <div className="rounded-xl bg-slate-50 px-4 py-6 text-center">
          <p className="text-sm text-slate-400">No itemised order on record.</p>
          {data.diagnostics?.latestCustomerSale && (
            <p className="mt-1 text-xs text-slate-400">Latest sale {fmtDay(data.diagnostics.latestCustomerSale)}.</p>
          )}
        </div>
      )}

      {/* Monthly sales — last 12 months */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Sales · last 12 months</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-2 font-semibold">Month</th>
                <th className="pb-2 text-right font-semibold">Sales</th>
                <th className="pb-2 text-right font-semibold">KG</th>
                <th className="pb-2 text-right font-semibold">YTD</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={`${m.year}-${m.month}`} className={`border-t border-slate-100 ${m.sales === 0 ? "text-slate-300" : "text-slate-700"}`}>
                  <td className="py-1.5 font-medium">{MONTH_NAMES[m.month - 1]} {String(m.year).slice(2)}</td>
                  <td className="py-1.5 text-right">{gbp(m.sales)}</td>
                  <td className="py-1.5 text-right">{Math.round(m.kg)}</td>
                  <td className="py-1.5 text-right text-slate-500">{gbp(m.ytd)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 font-semibold text-slate-900">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right">{gbp(totalSales)}</td>
                <td className="py-1.5 text-right">{Math.round(totalKg)}</td>
                <td className="py-1.5" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Product breakdown — last 3 months */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Products · last 3 months</p>
        {products.length === 0 ? (
          <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">
            No orders in the last 3 months.
            {data.diagnostics?.latestCustomerSale && <> Latest sale {fmtDay(data.diagnostics.latestCustomerSale)}.</>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 font-semibold">Product</th>
                  <th className="pb-2 text-right font-semibold">KG</th>
                  <th className="pb-2 text-right font-semibold">Sales</th>
                  <th className="pb-2 pl-2 text-right font-semibold">Last sale</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={`${p.code}-${p.description}`} className="border-t border-slate-100 text-slate-700">
                    <td className="py-1.5 pr-2">
                      <span className="block text-[13px] font-medium leading-snug">{titleCase(p.description)}</span>
                      {p.code && <span className="text-[10px] text-slate-400">{p.code}</span>}
                    </td>
                    <td className="py-1.5 text-right align-top">{Math.round(p.kg)}</td>
                    <td className="py-1.5 text-right align-top">{gbp(p.sales)}</td>
                    <td className="whitespace-nowrap py-1.5 pl-2 text-right align-top text-xs text-slate-500">{fmtDay(p.lastSale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tracking-[-0.01em] text-slate-900 [font-variant-numeric:tabular-nums]">{value}</p>
    </div>
  );
}

// "Last sale" stat that toggles between the last real ORDER (excludes £0 sample
// lines) and the last SAMPLE (only £0 + weight lines). Tap the label to switch.
function LastSaleStat({ orderDate, sampleDate }: { orderDate: string | null; sampleDate: string | null }) {
  const [mode, setMode] = useState<"order" | "sample">("order");
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <button
        onClick={() => setMode((m) => (m === "order" ? "sample" : "order"))}
        className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-brand-600"
        title="Switch between last order and last sample"
      >
        {mode === "order" ? "Last order" : "Last sample"}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m17 2 4 4-4 4" /><path d="M3 6h18" /><path d="m7 22-4-4 4-4" /><path d="M21 18H3" />
        </svg>
      </button>
      <p className="mt-0.5 text-lg font-semibold tracking-[-0.01em] text-slate-900 [font-variant-numeric:tabular-nums]">{fmtDay(mode === "order" ? orderDate : sampleDate)}</p>
    </div>
  );
}

