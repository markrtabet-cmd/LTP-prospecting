"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { RELEVANT_SECTORS } from "@/lib/sectors";

// Add / edit a customer (admin only — the API enforces the role). Because Power
// BI is the read-only source of truth and the nightly sync rewrites customer
// fields, the API records these as persistent edits keyed by the Centric account
// code so the sync re-applies them (see /api/customers/manage). On ADD we require
// the same fields the auto-pulled profiles carry, so a hand-added customer is as
// complete as a synced one.

const BUSINESS_TYPES = ["Customer account", "Restaurant", "Hotel restaurant", "Gastro-pub", "Deli / Food hall", "Caterer", "Members' club", "Farm shop", "Bistro", "Trattoria"];
const CUISINE_OPTIONS = ["Italian", "Modern European", "Mediterranean", "British", "French", "Gastro-pub", "Seafood", "Steakhouse", "Deli / Mediterranean", "Caterer / Events"];

export interface CustomerEditorFields {
  name: string;
  accountCode: string;
  postcode: string;
  address: string;
  contactName: string;
  phone: string;
  email: string;
  sector: string;
  accountManager: string;
  businessType: string;
  cuisineType: string;
}

const EMPTY: CustomerEditorFields = {
  name: "", accountCode: "", postcode: "", address: "", contactName: "", phone: "",
  email: "", sector: "", accountManager: "", businessType: "Customer account", cuisineType: "Italian",
};

// Fields required on ADD so a manually-added profile is as complete as a synced one.
const REQUIRED_ON_ADD: (keyof CustomerEditorFields)[] = [
  "name", "accountCode", "postcode", "address", "contactName", "phone", "sector", "accountManager",
];

export function CustomerEditor({
  mode,
  venueId,
  initial,
  onDone,
  onCancel,
}: {
  mode: "add" | "edit";
  venueId?: string;
  initial?: Partial<CustomerEditorFields>;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const { refresh } = useRestaurants();
  const [f, setF] = useState<CustomerEditorFields>({ ...EMPTY, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof CustomerEditorFields>(key: K, value: CustomerEditorFields[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  const missing = mode === "add" ? REQUIRED_ON_ADD.filter((k) => !f[k].trim()) : [];
  const canSubmit = mode === "edit" || missing.length === 0;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customers/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: mode, id: venueId, fields: f }),
      });
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!data.ok || !data.id) {
        setError(
          data.error === "no-location"
            ? "That postcode didn't resolve to a location — check it's correct."
            : data.error === "forbidden"
              ? "Only admins can add or edit customers."
              : data.error || "Something went wrong.",
        );
        setBusy(false);
        return;
      }
      refresh();
      onDone(data.id);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer name" required={mode === "add"}>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="e.g. Novotel London West" />
        </Field>
        <Field label="Centric account code" required={mode === "add"} hint="Links this record to Power BI / Centric">
          <input value={f.accountCode} onChange={(e) => set("accountCode", e.target.value.toUpperCase())} className={inputCls} placeholder="e.g. NOVOWE" disabled={mode === "edit" && !!initial?.accountCode} />
        </Field>
        <Field label="Postcode" required={mode === "add"} hint="Sets the map pin (re-geocoded on change)">
          <input value={f.postcode} onChange={(e) => set("postcode", e.target.value.toUpperCase())} className={inputCls} placeholder="e.g. EC3A 8BF" />
        </Field>
        <Field label="Full address" required={mode === "add"}>
          <input value={f.address} onChange={(e) => set("address", e.target.value)} className={inputCls} placeholder="Street, area" />
        </Field>
        <Field label="Contact name" required={mode === "add"}>
          <input value={f.contactName} onChange={(e) => set("contactName", e.target.value)} className={inputCls} placeholder="Main contact" />
        </Field>
        <Field label="Phone" required={mode === "add"}>
          <input value={f.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} placeholder="Contact number" />
        </Field>
        <Field label="Email">
          <input value={f.email} onChange={(e) => set("email", e.target.value)} className={inputCls} placeholder="Contact email" />
        </Field>
        <Field label="Sector" required={mode === "add"}>
          <select value={f.sector} onChange={(e) => set("sector", e.target.value)} className={inputCls}>
            <option value="">Choose a sector…</option>
            {RELEVANT_SECTORS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Account manager (sales rep)" required={mode === "add"} hint="The Power BI account-manager spelling">
          <input value={f.accountManager} onChange={(e) => set("accountManager", e.target.value)} className={inputCls} placeholder="e.g. TURI" />
        </Field>
        <Field label="Business type">
          <select value={f.businessType} onChange={(e) => set("businessType", e.target.value)} className={inputCls}>
            {BUSINESS_TYPES.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="Cuisine">
          <select value={f.cuisineType} onChange={(e) => set("cuisineType", e.target.value)} className={inputCls}>
            {CUISINE_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">{error}</p>}
      {mode === "add" && missing.length > 0 && (
        <p className="text-xs text-slate-400">Fill in the required fields (marked *) so the profile is as complete as a synced one.</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white transition ${
            canSubmit && !busy ? "bg-brand-500 hover:bg-brand-600 active:scale-[0.98]" : "cursor-not-allowed bg-slate-300"
          }`}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === "add" ? "Add customer" : "Save changes"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-slate-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500";

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
