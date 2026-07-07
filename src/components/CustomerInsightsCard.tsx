"use client";

import { useEffect, useState } from "react";
import type { Restaurant } from "@/lib/types";
import type { CustomerInsights } from "@/app/api/powerbi/customer-insights/route";

// Desktop customer profile: the same live Power BI account + sales figures the
// phone shows on a customer's Sales/Contact slides, laid out for a wide screen.
// Fetched fresh every time the profile opens (never cached — see the API route),
// so the numbers track Power BI as it refreshes. Customers see this instead of
// the prospecting lead-score breakdown, which is meaningless once they're a
// customer.

type State =
  | { status: "loading" }
  | { status: "unlinked" }
  | { status: "error"; message?: string }
  | { status: "ready"; data: CustomerInsights };

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

export function CustomerInsightsCard({ r }: { r: Restaurant }) {
  const [state, setState] = useState<State>({ status: "loading" });

  // Re-fetch whenever the identifying fields change (or the profile remounts).
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (r.customerAccountCode) qs.set("code", r.customerAccountCode);
    qs.set("name", r.name);
    if (r.postcode) qs.set("postcode", r.postcode);
    setState({ status: "loading" });
    fetch(`/api/powerbi/customer-insights?${qs.toString()}`)
      .then((res) => res.json())
      .then((d: CustomerInsights) => {
        if (cancelled) return;
        if (d.error) setState({ status: "error", message: d.error });
        else if (!d.configured || !d.found) setState({ status: "unlinked" });
        else setState({ status: "ready", data: d });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Network error" });
      });
    return () => {
      cancelled = true;
    };
  }, [r.id, r.customerAccountCode, r.name, r.postcode]);

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Sales &amp; account</h2>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          Live from Power BI
        </span>
      </div>

      {state.status === "loading" && (
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

      {state.status === "ready" && <Ready data={state.data} r={r} />}
    </div>
  );
}

function Ready({ data, r }: { data: CustomerInsights; r: Restaurant }) {
  const a = data.account;
  const months = data.monthly;
  const products = data.products;
  const totalSales = months.reduce((s, m) => s + m.sales, 0);
  const totalKg = months.reduce((s, m) => s + m.kg, 0);
  const stale = data.diagnostics?.stale;
  const staleSince = data.diagnostics?.datasetRefreshedAt?.slice(0, 10) ?? data.diagnostics?.latestDatasetSale ?? null;

  const statusUp = (a?.accountStatus ?? "").toUpperCase();

  return (
    <div className="space-y-6">
      {stale && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Power BI hasn&apos;t refreshed since {fmtDay(staleSince)} — these figures may be out of date.
        </div>
      )}

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sales · 12 mo" value={gbp(totalSales)} />
        <Stat label="KG · 12 mo" value={Math.round(totalKg).toLocaleString("en-GB")} />
        <Stat label="Avg order" value={a?.adv != null ? gbp(a.adv) : "—"} />
        <Stat label="Last sale" value={fmtDay(a?.lastSale ?? null)} />
      </div>

      {/* Account facts */}
      {a && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Account</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Account manager" value={a.salesRep ? titleCase(a.salesRep) : r.customerAccountManager || "—"} />
            <Fact
              label="Status"
              node={
                a.accountStatus ? (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      statusUp === "ACTIVE" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {titleCase(a.accountStatus)}
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <Fact label="Customer group" value={a.customerGroup || "—"} />
            <Fact label="Payment method" value={a.paymentMethod || "—"} />
            <Fact label="Terms" value={a.terms || "—"} />
            <Fact label="Price list" value={a.priceList || "—"} />
            <Fact label="Min order" value={a.minOrder != null ? gbp(a.minOrder) : "—"} />
            <Fact label="Last route" value={a.lastRoute || "—"} />
          </dl>
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

      {/* Contacts */}
      {data.contacts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Contacts</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.contacts.map((c, i) => (
              <div key={i} className="rounded-xl bg-slate-50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{c.name ? titleCase(c.name) : "Contact"}</p>
                  {c.role && <span className="shrink-0 text-xs text-slate-400">{titleCase(c.role)}</span>}
                </div>
                {(c.phone1 || c.phone2) && (
                  <p className="mt-1 text-sm">
                    {[c.phone1, c.phone2].filter(Boolean).map((p) => (
                      <a key={p} href={`tel:${p}`} className="mr-3 text-brand-600 hover:underline">{p}</a>
                    ))}
                  </p>
                )}
                {c.email && (
                  <p className="mt-0.5 text-sm">
                    <a href={`mailto:${c.email}`} className="break-all text-brand-600 hover:underline">{c.email.toLowerCase()}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
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

function Fact({ label, value, node }: { label: string; value?: string; node?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-50 pb-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{node ?? value}</dd>
    </div>
  );
}
