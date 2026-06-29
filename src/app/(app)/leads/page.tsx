"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { LeadBadge, OutreachBadge, PriceTag, RecommendBadge } from "@/components/StatusBadge";
import { MultiSelect } from "@/components/MultiSelect";
import { useRestaurants } from "@/lib/store";
import type { LeadCategory } from "@/lib/types";

const PAGE_SIZE = 100;

export default function LeadsPage() {
  const { restaurants, loading, focusIds, setFocusIds, viewFilter, setViewFilter } = useRestaurants();
  const focusSet = useMemo(() => (focusIds ? new Set(focusIds) : null), [focusIds]);
  const base = useMemo(() => (focusSet ? restaurants.filter((r) => focusSet.has(r.id)) : restaurants), [restaurants, focusSet]);

  const boroughs = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.borough))).sort(),
    [restaurants]
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.cuisineType))).sort(),
    [restaurants]
  );

  const [search, setSearch] = useState("");
  const [boroughSel, setBoroughSel] = useState<string[]>([]);
  const [cuisineSel, setCuisineSel] = useState<string[]>([]);
  const [category, setCategory] = useState<LeadCategory | "">("");
  const [onlyRecommended, setOnlyRecommended] = useState(false);
  const [onlyCustomers, setOnlyCustomers] = useState(false);
  const [onlyEmail, setOnlyEmail] = useState(false);
  const [hideExcluded, setHideExcluded] = useState(true);
  const [page, setPage] = useState(0);

  // Initialise filters from the URL (direct/deep links, e.g. /leads?cuisine=Italian).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("cuisine")) setCuisineSel([p.get("cuisine")!]);
    if (p.get("borough")) setBoroughSel([p.get("borough")!]);
    if (p.get("text")) setSearch(p.get("text")!);
    if (p.get("score")) setCategory(p.get("score") as LeadCategory);
    if (p.get("recommended") === "1") setOnlyRecommended(true);
    if (p.get("customers") === "1") setOnlyCustomers(true);
    if (p.get("email") === "1") setOnlyEmail(true);
  }, []);

  // Apply the assistant's filter reactively (works even when already on this
  // page), then clear it so manual edits aren't overwritten.
  useEffect(() => {
    if (!viewFilter) return;
    setCuisineSel(viewFilter.cuisines ?? []);
    setBoroughSel(viewFilter.boroughs ?? []);
    setSearch(viewFilter.text ?? "");
    setCategory("");
    setOnlyRecommended(!!viewFilter.recommendedOnly);
    setOnlyCustomers(!!viewFilter.existingCustomerOnly);
    setOnlyEmail(false);
    setHideExcluded(!viewFilter.includeExcluded); // show poor-fit venues when explicitly asked
    setViewFilter(null);
  }, [viewFilter, setViewFilter]);

  const rows = useMemo(() => {
    const boroughLC = boroughSel.map((b) => b.toLowerCase());
    const cuisineLC = cuisineSel.map((c) => c.toLowerCase());
    const out = base
      .filter((r) => (hideExcluded ? !r.excluded : true))
      .filter((r) => (boroughLC.length ? boroughLC.includes(r.borough.toLowerCase()) : true))
      .filter((r) => (cuisineLC.length ? cuisineLC.includes(r.cuisineType.toLowerCase()) : true))
      .filter((r) => (category ? r.leadCategory === category : true))
      .filter((r) => (onlyRecommended ? r.recommended : true))
      .filter((r) => (onlyCustomers ? r.existingCustomer : true))
      .filter((r) => (onlyEmail ? Boolean(r.email) : true))
      .filter((r) =>
        search
          ? `${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`.toLowerCase().includes(search.toLowerCase())
          : true
      );
    out.sort((a, b) => b.leadScore - a.leadScore);
    return out;
  }, [base, search, boroughSel, cuisineSel, category, onlyRecommended, onlyCustomers, onlyEmail, hideExcluded]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Reset to first page when filters change.
  const filterKey = `${search}|${boroughSel.join(",")}|${cuisineSel.join(",")}|${category}|${onlyRecommended}|${onlyCustomers}|${onlyEmail}|${hideExcluded}`;
  const [lastKey, setLastKey] = useState(filterKey);
  if (filterKey !== lastKey) {
    setLastKey(filterKey);
    setPage(0);
  }

  return (
    <div>
      <PageHeader
        title="Lead database"
        subtitle={loading ? "Loading London venues…" : `${rows.length.toLocaleString()} of ${restaurants.length.toLocaleString()} venues shown`}
        action={
          <div className="flex gap-2">
            <Link href="/add" className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600">
              + Add customer
            </Link>
            <Link href="/map" className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
              View on Map →
            </Link>
          </div>
        }
      />

      {focusIds && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
          <span>Showing <b>{focusIds.length}</b> venues matched from your file.</span>
          <button onClick={() => setFocusIds(null)} className="font-medium text-amber-700 hover:underline">Clear ✕</button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, borough, postcode…"
          className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
        />
        <MultiSelect label="Boroughs" options={boroughs} selected={boroughSel} onChange={setBoroughSel} />
        <MultiSelect label="Cuisines" options={cuisines} selected={cuisineSel} onChange={setCuisineSel} />
        <select value={category} onChange={(e) => setCategory(e.target.value as LeadCategory | "")} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="">All scores</option>
          <option value="high">High priority</option>
          <option value="good">Good</option>
          <option value="possible">Possible</option>
          <option value="low">Low / excluded</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={onlyRecommended} onChange={(e) => setOnlyRecommended(e.target.checked)} /> Recommended</label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={onlyCustomers} onChange={(e) => setOnlyCustomers(e.target.checked)} /> Customers</label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={onlyEmail} onChange={(e) => setOnlyEmail(e.target.checked)} /> Has email</label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={hideExcluded} onChange={(e) => setHideExcluded(e.target.checked)} /> Hide excluded</label>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Restaurant</th>
              <th className="px-4 py-3">Borough</th>
              <th className="px-4 py-3">Cuisine</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Lead</th>
              <th className="px-4 py-3">Contact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageRows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/restaurants/${r.id}`} className="font-medium text-slate-800 hover:text-brand-600">{r.name}</Link>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {(r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") && (
                      <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
                        {r.openingStatus === "new_this_week" ? "New" : "Opening soon"}
                      </span>
                    )}
                    {r.existingCustomer && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">Customer</span>}
                    {r.recommended && !r.existingCustomer && <RecommendBadge />}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-600">{r.borough}</td>
                <td className="px-4 py-3 text-slate-600">{r.cuisineType}</td>
                <td className="px-4 py-3"><PriceTag tier={r.priceTier} /></td>
                <td className="px-4 py-3 font-semibold text-slate-800">{r.leadScore}</td>
                <td className="px-4 py-3"><LeadBadge category={r.leadCategory} /></td>
                <td className="px-4 py-3 text-slate-500">{r.email ?? "—"}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No restaurants match these filters.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} className="rounded-lg bg-white px-3 py-1.5 font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40">← Prev</button>
          <span className="text-slate-500">Page {safePage + 1} of {pageCount}</span>
          <button onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1} className="rounded-lg bg-white px-3 py-1.5 font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40">Next →</button>
        </div>
      )}
    </div>
  );
}
