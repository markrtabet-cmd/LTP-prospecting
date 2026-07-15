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

export default function InsightsPage() {
  const { restaurants, allRestaurants } = useRestaurants();
  const { me, reps, seesEverything } = useRep();

  const rep = useMemo(
    () => (me ? reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null),
    [me, reps],
  );
  const myCustomers = useMemo(() => {
    if (seesEverything) return restaurants.filter((r) => r.existingCustomer);
    return rep ? venuesForRep(restaurants, rep, reps).filter((r) => r.existingCustomer) : [];
  }, [restaurants, rep, reps, seesEverything]);
  const scopeCodes = useMemo<string[] | null>(
    () => (seesEverything ? null : myCustomers.map((c) => c.customerAccountCode).filter((x): x is string => !!x)),
    [seesEverything, myCustomers],
  );
  // Key the fetch on the scope's CONTENT, not the array reference — otherwise
  // the store's 2-min background refresh (which rebuilds `restaurants`) hands us
  // a fresh scopeCodes array with identical codes and needlessly re-queries
  // Power BI, blanking the page and jumping the scroll to the top.
  const scopeKey = scopeCodes === null ? "*" : [...scopeCodes].sort().join(",");

  const [data, setData] = useState<SalesInsights | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [samplesMode, setSamplesMode] = useState<"customers" | "prospects">("customers");

  // Prospect samples come from the activity log (manually logged "samples sent"
  // to non-customer venues), not Power BI — mirrors the customer side's 10-day
  // window and honours rep scoping (a rep sees only their own logged samples).
  const prospectSamples = useMemo(() => {
    const cutoff = Date.now() - 10 * 86_400_000;
    const out: { id: string; name: string; date: string | null }[] = [];
    for (const r of allRestaurants) {
      if (r.existingCustomer) continue;
      for (const n of r.contactLog ?? []) {
        if (n.outcome !== "samples_sent") continue;
        const t = Date.parse(n.at);
        if (!Number.isFinite(t) || t < cutoff) continue;
        if (!seesEverything && me && n.repId && n.repId !== me.id) continue;
        out.push({ id: r.id, name: r.name, date: new Date(t).toISOString().slice(0, 10) });
      }
    }
    return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }, [allRestaurants, seesEverything, me]);
  useEffect(() => {
    let alive = true;
    // Spinner only before the first load; a scope change while data is on screen
    // refreshes in the background (no blank, no scroll jump).
    setState((s) => (s === "ready" ? s : "loading"));
    fetch("/api/insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes: scopeCodes }) })
      .then((r) => r.json())
      .then((d: SalesInsights) => {
        if (!alive) return;
        if (d.configured) { setData(d); setState("ready"); }
        else setState((s) => (s === "ready" ? s : "error"));
      })
      .catch(() => { if (alive) setState((s) => (s === "ready" ? s : "error")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

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
        subtitle={`Sales & product insights · ${seesEverything ? "whole company" : "your customers"} · last 30 days unless noted`}
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
                title="Samples sent (last 10 days)"
                wide
                note={
                  <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
                    <button onClick={() => setSamplesMode("customers")} className={samplesMode === "customers" ? "rounded-md bg-white px-2.5 py-1 text-slate-800 shadow-sm" : "px-2.5 py-1 text-slate-500"}>Customers</button>
                    <button onClick={() => setSamplesMode("prospects")} className={samplesMode === "prospects" ? "rounded-md bg-white px-2.5 py-1 text-slate-800 shadow-sm" : "px-2.5 py-1 text-slate-500"}>Prospects</button>
                  </div>
                }
              >
                {samplesMode === "customers" ? (
                  data.samples10.length === 0 ? <Empty>No samples sent to customers in the last 10 days.</Empty> : (
                    <Ranked numbered={false} rows={data.samples10.map((s) => ({ label: nameLink(s.code, s.name), value: <span className="text-slate-400">{s.date ?? ""}</span> }))} />
                  )
                ) : (
                  prospectSamples.length === 0 ? <Empty>No samples logged to prospects in the last 10 days.</Empty> : (
                    <Ranked numbered={false} rows={prospectSamples.map((s) => ({ label: <Link href={`/restaurants/${s.id}?from=dashboard`} className="font-medium text-brand-700 hover:underline">{titleCase(s.name)}</Link>, value: <span className="text-slate-400">{s.date ?? ""}</span> }))} />
                  )
                )}
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
