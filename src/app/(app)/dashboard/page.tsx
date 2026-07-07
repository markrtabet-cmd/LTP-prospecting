"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Sparkles, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { BusinessHealthDigest } from "@/components/BusinessHealthDigest";
import { TodaysAgenda } from "@/components/TodaysAgenda";
import { OutreachBadge, PriceTag } from "@/components/StatusBadge";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { venuesForRep } from "@/lib/visits/schedule";
import { getRegion } from "@/lib/locations";
import { isNewOpening, type Restaurant } from "@/lib/types";

// Proxy for "became a customer in the last ~30 days": no acquisition date is
// synced, so use the earliest month with sales from the customer's Power BI
// sales history. Approximate, and only as good as the synced history window.
function isNewCustomer30d(r: Restaurant): boolean {
  const months = r.salesHistory?.monthly;
  if (!months || months.length === 0) return false;
  const firstWithSales = months.find((m) => m.sales > 0);
  if (!firstWithSales) return false;
  const [y, mo] = firstWithSales.month.split("-").map(Number);
  if (!y || !mo) return false;
  const daysSince = (Date.now() - new Date(y, mo - 1, 1).getTime()) / 86_400_000;
  return daysSince <= 35;
}

const IN_PROGRESS: string[] = ["sent", "replied", "scheduled"];

export default function DashboardPage() {
  const { restaurants, loading, londonOnly } = useRestaurants();
  const { me, reps } = useRep();

  // The KPIs are for the signed-in rep. Fall back to Stefano / the first rostered
  // rep when nobody is signed in, and to app-wide when there's no roster at all.
  const rep = useMemo(() => {
    if (me) return reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] };
    return reps.find((r) => /stefano/i.test(r.name)) ?? reps[0] ?? null;
  }, [me, reps]);

  const myVenues = useMemo(
    () => (rep ? venuesForRep(restaurants, rep, reps) : restaurants),
    [restaurants, rep, reps],
  );
  const myCustomers = useMemo(() => myVenues.filter((r) => r.existingCustomer), [myVenues]);
  const totalCustomers = myCustomers.length;
  const newCustomers = useMemo(() => myCustomers.filter(isNewCustomer30d).length, [myCustomers]);
  const activeProspects = useMemo(
    () => myVenues.filter((r) => !r.existingCustomer && IN_PROGRESS.includes(r.outreachStatus)).length,
    [myVenues],
  );
  // New openings are pipeline-wide (not rep-scoped) — a shared signal of fresh
  // venues to chase, counted the same way the Leads "New openings" filter does.
  const newOpenings = useMemo(() => restaurants.filter(isNewOpening).length, [restaurants]);

  const bestFits = useMemo(
    () =>
      restaurants
        .filter((r) => r.recommended && !r.existingCustomer)
        .sort((a, b) => b.leadScore - a.leadScore)
        .slice(0, 6),
    [restaurants]
  );
  const customers = useMemo(
    () => restaurants.filter((r) => r.existingCustomer).slice(0, 6),
    [restaurants]
  );

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Your ${londonOnly ? "London" : "UK"} restaurant pipeline at a glance`}
        action={
          <Link
            href="/add"
            className="rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-[background-color,transform] duration-150 hover:bg-brand-600 active:scale-[0.98] active:bg-brand-700"
          >
            + Add venue
          </Link>
        }
      />

      {/* KPI cards — the signed-in rep's own numbers, plus pipeline-wide openings */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total customers" value={loading ? "…" : totalCustomers.toLocaleString()} accent="blue" sub={rep ? "your accounts" : "all accounts"} delay={0} />
        <StatCard label="New customers" value={loading ? "…" : newCustomers.toLocaleString()} accent="green" sub="in the last 30 days" delay={55} />
        <StatCard label="Active prospects" value={loading ? "…" : activeProspects.toLocaleString()} accent="amber" sub="awaiting reply or in contact" delay={110} />
        <StatCard label="New openings" value={loading ? "…" : newOpenings.toLocaleString()} accent="purple" sub="newly opened or opening soon" delay={165} />
      </div>

      {/* Three action panels */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Best fits */}
        <Panel
          icon={<Sparkles size={16} className="text-green-600" />}
          title="Best fits to contact"
          linkLabel="View all"
          href="/leads?recommended=1"
          delay={360}
        >
          {bestFits.length === 0 ? (
            <Empty>No recommended venues yet.</Empty>
          ) : (
            <ul className="-mx-2 divide-y divide-slate-100">
              {bestFits.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-3 transition-colors duration-150 hover:bg-slate-50">
                  <div className="min-w-0">
                    <Link href={`/restaurants/${r.id}`} className="block truncate text-sm font-medium text-slate-800 transition-colors duration-150 hover:text-brand-600">{r.name}</Link>
                    <p className="truncate text-xs text-slate-400">{r.cuisineType} · {londonOnly ? r.borough : getRegion(r.borough, r.postcode)} · <PriceTag tier={r.priceTier} /></p>
                  </div>
                  <span className="shrink-0 rounded-md bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700 [font-variant-numeric:tabular-nums]">{r.leadScore}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Existing customers */}
        <Panel
          icon={<Users size={16} className="text-blue-600" />}
          title="Existing customers"
          linkLabel="View all"
          href="/customers"
          delay={420}
        >
          {customers.length === 0 ? (
            <Empty>
              No customers yet — they sync automatically from Power BI overnight.
            </Empty>
          ) : (
            <ul className="-mx-2 divide-y divide-slate-100">
              {customers.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-3 transition-colors duration-150 hover:bg-slate-50">
                  <div className="min-w-0">
                    <Link href={`/restaurants/${r.id}`} className="block truncate text-sm font-medium text-slate-800 transition-colors duration-150 hover:text-brand-600">{r.name}</Link>
                    <p className="truncate text-xs text-slate-400">{r.cuisineType} · {londonOnly ? r.borough : getRegion(r.borough, r.postcode)}</p>
                  </div>
                  <OutreachBadge status={r.outreachStatus} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Today's calendar — what's booked today and coming up */}
        <TodaysAgenda />
      </div>

      <BusinessHealthDigest />
    </div>
  );
}

function Panel({ icon, title, linkLabel, href, children, delay = 0 }: { icon: React.ReactNode; title: string; linkLabel?: string; href?: string; children: React.ReactNode; delay?: number }) {
  return (
    <div
      className="anim-rise rounded-xl bg-white p-5 shadow-sm transition-shadow duration-150 hover:shadow-md"
      style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-slate-900">{icon}{title}</h2>
        {href && linkLabel && <Link href={href} className="text-xs font-medium text-brand-600 hover:underline">{linkLabel}</Link>}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400">{children}</p>;
}
