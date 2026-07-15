"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { venuesForRep } from "@/lib/visits/schedule";
import { chainKey } from "@/lib/chains";
import { isNewCustomer30d } from "@/lib/customer-activity";
import type { SalesInsights } from "@/lib/sales-analytics";

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}
function kgFmt(n: number): string {
  return `${Math.round(n).toLocaleString("en-GB")} kg`;
}
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// One sample "delivery": the £0 report lines for a recipient on a day.
interface SampleLine { stockCode: string; description: string; qty: number }
interface SampleEntry {
  key: string; custCode: string; name: string; postcode: string;
  date: string | null; isProspect: boolean; lines: SampleLine[];
}

export default function InsightsPage() {
  const { restaurants, allRestaurants, loading: venuesLoading } = useRestaurants();
  const { reps, seesEverything, subjectRep, loading: repLoading } = useRep();

  // Company overview vs one rep's book. A plain rep is scoped to themselves; an
  // admin follows the top-right switcher (a picked rep, or whole company).
  const companyView = seesEverything && !subjectRep;
  const myCustomers = useMemo(() => {
    if (companyView) return restaurants.filter((r) => r.existingCustomer);
    return subjectRep ? venuesForRep(restaurants, subjectRep, reps).filter((r) => r.existingCustomer) : [];
  }, [restaurants, subjectRep, companyView, reps]);
  const scopeCodes = useMemo<string[] | null>(
    () => (companyView ? null : myCustomers.map((c) => c.customerAccountCode).filter((x): x is string => !!x)),
    [companyView, myCustomers],
  );
  // Key the fetch on the scope's CONTENT, not the array reference — otherwise
  // the store's 2-min background refresh (which rebuilds `restaurants`) hands us
  // a fresh scopeCodes array with identical codes and needlessly re-queries
  // Power BI, blanking the page and jumping the scroll to the top.
  const scopeKey = scopeCodes === null ? "*" : [...scopeCodes].sort().join(",");
  // Don't fetch until the store + rep have loaded — an empty scope is a valid
  // query that returns an all-zero page. Both flags are one-way latches.
  const scopeReady = !venuesLoading && !repLoading;
  const repName = subjectRep?.name ?? null;

  const [data, setData] = useState<SalesInsights | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [samplesMode, setSamplesMode] = useState<"customers" | "prospects">("customers");
  // Optional date filter for the samples card: empty = the last 10 days; a date
  // shows only samples sent that day (can be older than 10 days).
  const [samplesDate, setSamplesDate] = useState("");
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const filterSamples = <T extends { date: string | null }>(list: T[]): T[] =>
    samplesDate ? list.filter((s) => s.date === samplesDate) : list.filter((s) => (s.date ?? "") >= tenDaysAgo);

  // The samples list is line-level (one row per £0 product line, straight from
  // the report's Samples page). Group into one entry per (recipient, day) —
  // each entry expands to its detail lines. Prospect entries are the rows
  // booked on the rep's pseudo-account: [Name] is the actual recipient.
  const sampleEntries = useMemo<SampleEntry[]>(() => {
    const m = new Map<string, SampleEntry>();
    for (const s of data?.samples10 ?? []) {
      const key = `${s.custCode}|${s.name}|${s.date ?? ""}`;
      let e = m.get(key);
      if (!e) {
        e = { key, custCode: s.custCode, name: s.name, postcode: s.postcode, date: s.date, isProspect: s.isProspect, lines: [] };
        m.set(key, e);
      }
      e.lines.push({ stockCode: s.stockCode, description: s.description, qty: s.qty });
    }
    return Array.from(m.values()).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }, [data]);
  const [openSample, setOpenSample] = useState<string | null>(null);
  useEffect(() => {
    // Wait for the real scope — fetching with a not-yet-loaded (empty) scope
    // briefly rendered every card as "No data."/£0.
    if (!scopeReady) return;
    let alive = true;
    // Spinner only before the first load; a scope change while data is on screen
    // refreshes in the background (no blank, no scroll jump).
    setState((s) => (s === "ready" ? s : "loading"));
    fetch("/api/insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes: scopeCodes, repName }) })
      .then((r) => r.json())
      .then((d: SalesInsights) => {
        if (!alive) return;
        if (d.configured) { setData(d); setState("ready"); }
        else setState((s) => (s === "ready" ? s : "error"));
      })
      .catch(() => { if (alive) setState((s) => (s === "ready" ? s : "error")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, repName, scopeReady]);

  const codeToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRestaurants) if (r.customerAccountCode) m.set(r.customerAccountCode, r.id);
    return m;
  }, [allRestaurants]);

  const topCustomers = useMemo(() => (data ? [...data.perCustomer].sort((a, b) => b.sales - a.sales).slice(0, 10) : []), [data]);
  const topGroups = useMemo(() => {
    if (!data) return [];
    const g = new Map<string, { name: string; sales: number }>();
    for (const c of data.perCustomer) {
      const k = chainKey(c.name);
      const e = g.get(k) ?? { name: c.name, sales: 0 };
      e.sales += c.sales;
      g.set(k, e);
    }
    return Array.from(g.values()).sort((a, b) => b.sales - a.sales).slice(0, 10);
  }, [data]);
  const decreasing = useMemo(
    () => (data ? data.perCustomer.filter((c) => c.prevSales > c.sales).map((c) => ({ ...c, drop: c.prevSales - c.sales })).sort((a, b) => b.drop - a.drop).slice(0, 10) : []),
    [data],
  );
  const salesByCode = useMemo(() => {
    const m = new Map<string, number>();
    if (data) for (const c of data.perCustomer) m.set(c.code, c.sales);
    return m;
  }, [data]);
  const newCustomers = useMemo(
    () => myCustomers.filter((c) => isNewCustomer30d(c)).map((c) => ({
      name: c.name, id: c.id, sales: c.customerAccountCode ? salesByCode.get(c.customerAccountCode) ?? 0 : 0,
    })),
    [myCustomers, salesByCode],
  );
  const topProductsKg = useMemo(() => (data ? [...data.productsTop].sort((a, b) => b.kg - a.kg).slice(0, 10) : []), [data]);
  const topProductsValue = useMemo(() => (data ? [...data.productsTop].sort((a, b) => b.sales - a.sales).slice(0, 10) : []), [data]);

  const nameLink = (code: string | undefined, name: string) => {
    const id = code ? codeToId.get(code) : undefined;
    return id ? (
      <Link href={`/restaurants/${id}?from=dashboard`} className="font-medium text-brand-700 hover:underline">{titleCase(name)}</Link>
    ) : (
      <span className="font-medium text-slate-800">{titleCase(name)}</span>
    );
  };

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle={`Sales & product insights · ${companyView ? "whole company" : seesEverything && subjectRep ? `${subjectRep.name}'s customers` : "your customers"} · last 30 days unless noted`}
      />

      {state === "loading" && (
        <div className="flex h-60 items-center justify-center">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
        </div>
      )}
      {state === "error" && (
        <div className="rounded-xl bg-amber-50 p-6 text-center text-sm text-amber-800 ring-1 ring-amber-200">
          Couldn&apos;t load insights from Power BI. Check the connection and try again.
        </div>
      )}

      {state === "ready" && data && (
        <div className="space-y-8">
          <Section title="Sales insights">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Top 10 customers · spend (30d)" note={data.totals && <PrevNote cur={data.totals.sales30} prev={data.totals.salesPrev} fmt={gbp} />}>
                <Ranked rows={topCustomers.map((c) => ({ label: nameLink(c.code, c.name), value: gbp(c.sales) }))} />
              </Card>
              <Card title="Top 10 groups · value (30d)" note={data.totals && <PrevNote cur={data.totals.sales30} prev={data.totals.salesPrev} fmt={gbp} />}>
                <Ranked rows={topGroups.map((g) => ({ label: <span className="font-medium text-slate-800">{titleCase(g.name)}</span>, value: gbp(g.sales) }))} />
              </Card>
              <Card title="Segment value (30d)" note={data.totals && <PrevNote cur={data.totals.sales30} prev={data.totals.salesPrev} fmt={gbp} />}>
                <Ranked rows={data.segments30.slice(0, 15).map((s) => ({ label: <span className="font-medium text-slate-800">{titleCase(s.segment)}</span>, value: gbp(s.sales) }))} />
              </Card>
              <Card title="New customers (30d)">
                {newCustomers.length === 0 ? <Empty>No new customers in the last 30 days.</Empty> : (
                  <Ranked numbered={false} rows={newCustomers.map((c) => ({ label: <Link href={`/restaurants/${c.id}?from=dashboard`} className="font-medium text-brand-700 hover:underline">{titleCase(c.name)}</Link>, value: c.sales ? gbp(c.sales) : "—" }))} />
                )}
              </Card>
              <Card title="Biggest sales drop · 30d vs prev 30d (£)">
                {decreasing.length === 0 ? <Empty>No customers with a sales drop.</Empty> : (
                  <Ranked rows={decreasing.map((c) => ({ label: nameLink(c.code, c.name), value: <span><span className="text-red-600">−{gbp(c.drop)}</span> <span className="text-slate-400">({gbp(c.sales)} vs {gbp(c.prevSales)})</span></span> }))} />
                )}
              </Card>
              <Card title="On stop (last 10 days)">
                {data.onStopNew.length === 0 ? <Empty>No accounts on stop in the last 10 days.</Empty> : (
                  <Ranked numbered={false} rows={data.onStopNew.map((c) => ({ label: nameLink(c.code, c.name), value: <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">On stop</span> }))} />
                )}
              </Card>
              <Card title="Requiring attention · broken ordering pattern" wide>
                {data.attention.length === 0 ? <Empty>Everyone is ordering to their usual pattern.</Empty> : (
                  <Ranked rows={data.attention.slice(0, 25).map((a) => ({
                    label: nameLink(a.code, a.name),
                    value: <span className="text-slate-500">{a.tierLabel ?? "regular"} · <span className="font-semibold text-amber-700">{a.daysSinceLast}d</span> since last order</span>,
                  }))} />
                )}
              </Card>
            </div>
          </Section>

          <Section title="Product insights">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Top 10 products · volume (kg, 30d)" note={data.totals && <PrevNote cur={data.totals.kg30} prev={data.totals.kgPrev} fmt={kgFmt} />}>
                <Ranked rows={topProductsKg.map((p) => ({ label: <span className="font-medium text-slate-800">{titleCase(p.description)}</span>, value: kgFmt(p.kg) }))} />
              </Card>
              <Card title="Top 10 products · value (£, 30d)" note={data.totals && <PrevNote cur={data.totals.sales30} prev={data.totals.salesPrev} fmt={gbp} />}>
                <Ranked rows={topProductsValue.map((p) => ({ label: <span className="font-medium text-slate-800">{titleCase(p.description)}</span>, value: gbp(p.sales) }))} />
              </Card>
              <Card title="Lasagna (30d)" note={data.totals && <PrevNote cur={data.totals.lasSales30} prev={data.totals.lasSalesPrev} fmt={gbp} />}>
                <div className="flex items-center gap-6 py-2">
                  <div><p className="text-xs uppercase tracking-wide text-slate-400">Volume</p><p className="text-xl font-bold text-slate-900">{kgFmt(data.lasagnaReadyToCook.kg)}</p></div>
                  <div><p className="text-xs uppercase tracking-wide text-slate-400">Value</p><p className="text-xl font-bold text-slate-900">{gbp(data.lasagnaReadyToCook.sales)}</p></div>
                </div>
              </Card>
              <Card title="New products">
                <Empty>Coming soon — to be set up as a dedicated Centric report.</Empty>
              </Card>
              <Card title="Top 10 fillings · volume (kg, 30d)" note={data.totals && <PrevNote cur={data.totals.fillKg30} prev={data.totals.fillKgPrev} fmt={kgFmt} />}>
                <Ranked rows={data.fillingsTopKg.map((p) => ({ label: <span className="font-medium text-slate-800">{titleCase(p.description)}</span>, value: kgFmt(p.kg) }))} />
              </Card>
              <Card title="Top 10 pasteurised pasta · volume (kg, 30d)" note={data.totals && <PrevNote cur={data.totals.pastKg30} prev={data.totals.pastKgPrev} fmt={kgFmt} />}>
                <Ranked rows={data.pasteurisedTopKg.map((p) => ({ label: <span className="font-medium text-slate-800">{titleCase(p.description)}</span>, value: kgFmt(p.kg) }))} />
              </Card>
              <Card
                title={`Samples sent${samplesDate ? "" : " (last 10 days)"}`}
                wide
                note={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
                      <button onClick={() => setSamplesMode("customers")} className={samplesMode === "customers" ? "rounded-md bg-white px-2.5 py-1 text-slate-800 shadow-sm" : "px-2.5 py-1 text-slate-500"}>Customers</button>
                      <button onClick={() => setSamplesMode("prospects")} className={samplesMode === "prospects" ? "rounded-md bg-white px-2.5 py-1 text-slate-800 shadow-sm" : "px-2.5 py-1 text-slate-500"}>Prospects</button>
                    </div>
                    <input
                      type="date"
                      value={samplesDate}
                      onChange={(e) => setSamplesDate(e.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-brand-500"
                      title="Show samples sent on a specific date"
                    />
                    {samplesDate && (
                      <button onClick={() => setSamplesDate("")} className="rounded-md px-1.5 py-1 text-xs text-slate-400 hover:text-slate-700" title="Clear date">✕</button>
                    )}
                  </div>
                }
              >
                {(() => {
                  const rows = filterSamples(sampleEntries.filter((e) => e.isProspect === (samplesMode === "prospects")));
                  if (rows.length === 0) {
                    return <Empty>No samples sent to {samplesMode} {samplesDate ? `on ${samplesDate}` : "in the last 10 days"}.</Empty>;
                  }
                  return (
                    <ul className="space-y-1.5 text-sm">
                      {rows.map((e) => {
                        const open = openSample === e.key;
                        const profileId = !e.isProspect ? codeToId.get(e.custCode) : undefined;
                        return (
                          <li key={e.key}>
                            <button
                              type="button"
                              onClick={() => setOpenSample((k) => (k === e.key ? null : e.key))}
                              className="flex w-full items-center justify-between gap-3 rounded-md text-left hover:bg-slate-50"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span className={`w-3 shrink-0 text-[10px] ${open ? "text-slate-500" : "text-slate-300"}`}>{open ? "▾" : "▸"}</span>
                                <span className="min-w-0 truncate font-medium text-slate-800">{titleCase(e.name)}</span>
                                {e.isProspect && <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">prospect</span>}
                              </span>
                              <span className="shrink-0 whitespace-nowrap text-slate-400 [font-variant-numeric:tabular-nums]">
                                {e.lines.length} item{e.lines.length === 1 ? "" : "s"} · {e.date ?? ""}
                              </span>
                            </button>
                            {open && (
                              <div className="mb-1 ml-5 mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs ring-1 ring-slate-100">
                                <p className="mb-1.5 text-slate-400">
                                  {e.postcode && <span>{e.postcode} · </span>}
                                  {e.isProspect ? <span>prospect sample on the {titleCase(e.custCode)} account</span> : <span>account {e.custCode}</span>}
                                  {profileId && (
                                    <span> · <Link href={`/restaurants/${profileId}?from=dashboard`} className="font-semibold text-brand-600 hover:underline">Open profile →</Link></span>
                                  )}
                                </p>
                                <ul className="space-y-0.5">
                                  {e.lines.map((l, i) => (
                                    <li key={i} className="flex items-center justify-between gap-3">
                                      <span className="min-w-0 truncate text-slate-700">{titleCase(l.description)}</span>
                                      <span className="shrink-0 whitespace-nowrap text-slate-500 [font-variant-numeric:tabular-nums]">{l.stockCode} · ×{l.qty}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
              </Card>
            </div>
          </Section>

          <p className="text-xs text-slate-400">Live from Power BI · generated {new Date(data.generatedAt).toLocaleString("en-GB")}</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

function Card({ title, wide, note, children }: { title: string; wide?: boolean; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 ${wide ? "lg:col-span-2" : ""}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {note && <div className="shrink-0 text-right">{note}</div>}
      </div>
      {children}
    </div>
  );
}

// A subtle "vs prev 30d" side note: shows the previous-30d figure and the
// change (▲ up / ▼ down, with %). Sits to the RIGHT of the card title — a
// secondary comparison, never the headline number.
function PrevNote({ cur, prev, fmt }: { cur: number; prev: number; fmt: (n: number) => string }) {
  if (!cur && !prev) return null;
  const diff = cur - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  const up = diff >= 0;
  return (
    <span className="text-[11px] leading-tight text-slate-400">
      vs prev 30d {fmt(prev)}{" "}
      <span className={up ? "text-emerald-600" : "text-red-600"}>
        {up ? "▲" : "▼"}{pct !== null ? ` ${up ? "+" : "−"}${Math.abs(pct)}%` : ` ${fmt(Math.abs(diff))}`}
      </span>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-sm text-slate-400">{children}</p>;
}

function Ranked({ rows, numbered = true }: { rows: { label: React.ReactNode; value: React.ReactNode }[]; numbered?: boolean }) {
  if (rows.length === 0) return <Empty>No data.</Empty>;
  return (
    <ol className="space-y-1.5 text-sm">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            {numbered && <span className="w-5 shrink-0 text-right text-xs font-semibold text-slate-300">{i + 1}</span>}
            <span className="min-w-0 truncate">{r.label}</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-slate-700 [font-variant-numeric:tabular-nums]">{r.value}</span>
        </li>
      ))}
    </ol>
  );
}
