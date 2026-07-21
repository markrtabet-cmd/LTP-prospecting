"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CustomerEditor } from "@/components/CustomerEditor";
import { useRep } from "@/lib/rep";

// Add a NEW customer with a complete profile, linked to Centric by account code.
// Admin/developer only (the API enforces it too). Distinct from /add, which only
// creates a prospect.
export default function NewCustomerPage() {
  const router = useRouter();
  const { seesEverything, loading } = useRep();

  return (
    <div>
      <PageHeader title="Add a customer" subtitle="Create a complete customer profile, linked to Power BI by its Centric account code" />

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
        </div>
      ) : !seesEverything ? (
        <div className="rounded-xl bg-amber-50 p-6 text-sm text-amber-800 ring-1 ring-amber-200">
          Only admins can add customers. Ask an admin, or add a prospect from{" "}
          <Link href="/add" className="font-semibold underline">Add venue</Link>.
        </div>
      ) : (
        <div className="max-w-3xl rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <p className="mb-4 text-xs text-slate-500">
            Enter the Centric account code so this record links to Power BI — once the account syncs, its live sales and
            history attach automatically, and anything you complete here that Centric leaves blank is kept.
          </p>
          <CustomerEditor
            mode="add"
            onDone={(id) => router.push(`/restaurants/${id}?from=customers`)}
            onCancel={() => router.push("/customers")}
          />
        </div>
      )}
    </div>
  );
}
