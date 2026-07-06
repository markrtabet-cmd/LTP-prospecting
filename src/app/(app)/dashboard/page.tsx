"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, Sparkles, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { BusinessHealthDigest } from "@/components/BusinessHealthDigest";
import { ConvertedBadge, ContactedBadge, LeadBadge, OutreachBadge, PriceTag } from "@/components/StatusBadge";
import { funnelCounts } from "@/lib/mock-data";
import { useRestaurants } from "@/lib/store";
import { getRegion } from "@/lib/locations";

const LIST_LIMIT = 50;

export default function DashboardPage() {
  const { restaurants, loading, updateRestaurant, londonOnly } = useRestaurants();
  const router = useRouter();
  const [q, setQ] = useState("");

  const f = useMemo(() => funnelCounts(restaurants), [restaurants]);

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
  const draftsReady = useMemo(
    () => restaurants.filter((r) => r.outreachStatus === "draft_ready").length,
    [restaurants]
  );

  const filtered = useMemo(() => {
    const list = q
      ? restaurants.filter((r) =>
          `${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`.toLowerCase().includes(q.toLowerCase())
        )
      : restaurants;
    return [...list].sort((a, b) => b.leadScore - a.leadScore);
  }, [restaurants, q]);
  const rows = filtered.slice(0, LIST_LIMIT);

  function generateTopDrafts() {
    const targets = restaurants
      .filter((r) => r.recommended && !r.existingCustomer && r.outreachStatus === "not_contacted")
      .sort((a, b) => b.leadScore - a.leadScore)
      .slice(0, 20);
    targets.forEach((r) => updateRestaurant(r.id, { outreachStatus: "draft_ready" }));
    router.push("/emails");
  }

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

      {/* KPI cards — staggered left-to-right so the row assembles gently */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={londonOnly ? "London venues" : "UK venues"} value={loading ? "…" : f.total.toLocaleString()} sub="real FSA data" delay={0} />
        <StatCard label="Best fits" value={loading ? "…" : f.recommended.toLocaleString()} accent="green" sub="cuisine + price" delay={55} />
        <StatCard label="Existing customers" value={f.customers} accent="blue" sub="already buying" delay={110} />
        <StatCard label="Emails ready" value={draftsReady} accent="purple" sub="to review" delay={165} />
        <StatCard label="Replies" value={f.replied} accent="amber" sub="awaiting follow-up" delay={220} />
        <StatCard label="Converted" value={f.converted} accent="green" sub="won" delay={275} />
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

        {/* Email generation */}
        <Panel icon={<Mail size={16} className="text-purple-600" />} title="Outreach emails" delay={480}>
          <p className="text-sm text-slate-600">
            {draftsReady > 0
              ? `${draftsReady} draft${draftsReady === 1 ? "" : "s"} ready to review.`
              : "No drafts yet. Generate personalised drafts for your best-fit venues."}
          </p>
          <ol className="mt-3 space-y-1 text-xs text-slate-500">
            <li>1. Generate drafts for best fits</li>
            <li>2. Review &amp; edit in the Email centre</li>
            <li>3. Approve &amp; send (nothing sends without you)</li>
          </ol>
          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={generateTopDrafts}
              className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-[background-color,transform] duration-150 hover:bg-brand-600 active:scale-[0.98] active:bg-brand-700"
            >
              Generate drafts for top 20 fits
            </button>
            <Link
              href="/emails"
              className="rounded-lg bg-white px-3 py-2 text-center text-sm font-medium text-slate-600 ring-1 ring-slate-200 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-800"
            >
              Open Email centre
            </Link>
          </div>
        </Panel>
      </div>

      <BusinessHealthDigest />

      {/* Full clickable list */}
      <div className="anim-rise mt-6 overflow-hidden rounded-xl bg-white shadow-sm" style={{ "--rise-delay": "560ms" } as React.CSSProperties}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 p-4">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">
            All restaurants <span className="text-sm font-normal text-slate-400">(showing {rows.length} of {filtered.length.toLocaleString()})</span>
          </h2>
          <div className="flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none transition-colors duration-150 focus:border-brand-400" />
            <Link href="/leads" className="text-xs font-medium text-brand-600 hover:underline">Full table →</Link>
          </div>
        </div>
        <div className="max-h-[26rem] overflow-y-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Restaurant</th>
                <th className="px-4 py-2">{londonOnly ? "Borough" : "Area"}</th>
                <th className="px-4 py-2">Cuisine</th>
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="transition-colors duration-150 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link href={`/restaurants/${r.id}`} className="font-medium text-slate-800 hover:text-brand-600">{r.name}</Link>
                    {r.existingCustomer && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">Customer</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{londonOnly ? r.borough : getRegion(r.borough, r.postcode)}</td>
                  <td className="px-4 py-2 text-slate-600">{r.cuisineType}</td>
                  <td className="px-4 py-2"><PriceTag tier={r.priceTier} /></td>
                  <td className="px-4 py-2 font-semibold text-slate-800">{r.leadScore}</td>
                  <td className="px-4 py-2">
                    {r.existingCustomer
                      ? <ConvertedBadge />
                      : r.contactLog?.length
                        ? <ContactedBadge lastAt={r.contactLog.reduce((a, b) => a.at > b.at ? a : b).at} />
                        : <LeadBadge category={r.leadCategory} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
