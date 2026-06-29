"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { OutreachBadge, PriceTag } from "@/components/StatusBadge";
import { useRestaurants } from "@/lib/store";

export default function CustomersPage() {
  const { restaurants, updateRestaurant, removeRestaurant } = useRestaurants();
  const [q, setQ] = useState("");

  function removeCustomer(id: string) {
    // Manually-added records are removed entirely; real FSA venues are just
    // un-flagged so they return to the prospect pool.
    if (id.startsWith("r-user-")) removeRestaurant(id);
    else updateRestaurant(id, { existingCustomer: false, outreachStatus: "not_contacted" });
  }

  const customers = useMemo(() => {
    const list = restaurants.filter((r) => r.existingCustomer);
    const filtered = q
      ? list.filter((r) => `${r.name} ${r.borough} ${r.cuisineType}`.toLowerCase().includes(q.toLowerCase()))
      : list;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }, [restaurants, q]);

  return (
    <div>
      <PageHeader
        title="Existing customers"
        subtitle={`${customers.length} restaurant${customers.length === 1 ? "" : "s"} already buying from La Tua Pasta`}
        action={
          <Link href="/add" className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            + Add customer
          </Link>
        }
      />

      {customers.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">No customers added yet.</p>
          <p className="mt-1 text-xs text-slate-400">
            Use <Link href="/add" className="text-brand-600 hover:underline">+ Add customer</Link>, or ask the assistant to “add these customers: …”.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500" />
          </div>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Restaurant</th>
                  <th className="px-4 py-3">Borough</th>
                  <th className="px-4 py-3">Cuisine</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/restaurants/${r.id}`} className="font-medium text-slate-800 hover:text-brand-600">{r.name}</Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.borough}</td>
                    <td className="px-4 py-3 text-slate-600">{r.cuisineType}</td>
                    <td className="px-4 py-3"><PriceTag tier={r.priceTier} /></td>
                    <td className="px-4 py-3"><OutreachBadge status={r.outreachStatus} /></td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => removeCustomer(r.id)}
                        className="text-xs font-medium text-slate-400 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
