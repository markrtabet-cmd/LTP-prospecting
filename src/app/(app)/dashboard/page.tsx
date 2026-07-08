"use client";

import { useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { BusinessHealthDigest } from "@/components/BusinessHealthDigest";
import { TodaysAgenda } from "@/components/TodaysAgenda";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { venuesForRep } from "@/lib/visits/schedule";
import {
  isActiveProspectForAnyone,
  isActiveProspectForRep,
} from "@/lib/ownership";
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

export default function DashboardPage() {
  const { restaurants, loading: venuesLoading, londonOnly } = useRestaurants();
  const { me, reps, role, seesEverything, loading: repLoading } = useRep();
  const loading = venuesLoading || repLoading;

  // Admins and developers see COMPANY-WIDE totals; a rep sees only their own
  // accounts and prospects. The signed-in rep's roster entry supplies the
  // Power BI aliases that decide which customers are theirs.
  const rep = useMemo(
    () => (me ? reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null),
    [me, reps],
  );

  // For reps: their own customers. For admins/devs: every customer.
  const myCustomers = useMemo(() => {
    if (seesEverything) return restaurants.filter((r) => r.existingCustomer);
    return rep ? venuesForRep(restaurants, rep, reps).filter((r) => r.existingCustomer) : [];
  }, [restaurants, rep, reps, seesEverything]);

  const totalCustomers = myCustomers.length;
  const newCustomers = useMemo(() => myCustomers.filter(isNewCustomer30d).length, [myCustomers]);

  const activeProspects = useMemo(() => {
    if (seesEverything) return restaurants.filter(isActiveProspectForAnyone).length;
    return me ? restaurants.filter((r) => isActiveProspectForRep(r, me.id)).length : 0;
  }, [restaurants, me, seesEverything]);

  // New openings are pipeline-wide (not rep-scoped) — a shared signal of fresh
  // venues to chase, counted the same way the Leads "New openings" filter does.
  const newOpenings = useMemo(() => restaurants.filter(isNewOpening).length, [restaurants]);

  const scoped = !seesEverything;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`${scoped ? "Your" : "The team's"} ${londonOnly ? "London" : "UK"} restaurant pipeline at a glance`}
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
        <StatCard label="Total customers" value={loading ? "…" : totalCustomers.toLocaleString()} accent="blue" sub={scoped ? "your accounts" : "all accounts"} delay={0} />
        <StatCard label="New customers" value={loading ? "…" : newCustomers.toLocaleString()} accent="green" sub="in the last 30 days" delay={55} />
        <StatCard label="Active prospects" value={loading ? "…" : activeProspects.toLocaleString()} accent="amber" sub={scoped ? "yours: claimed or in contact" : "claimed or in contact"} delay={110} />
        <StatCard label="New openings" value={loading ? "…" : newOpenings.toLocaleString()} accent="purple" sub="newly opened or opening soon" delay={165} />
      </div>

      {/* Today's calendar — what's booked today and coming up */}
      <div className="mt-6">
        <TodaysAgenda />
      </div>

      <BusinessHealthDigest />
    </div>
  );
}

