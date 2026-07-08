"use client";

import { useState } from "react";
import { useRestaurants } from "@/lib/store";
import type { Restaurant } from "@/lib/types";

// Sales reps arrive UPPERCASE from Power BI, with placeholder values on
// unassigned/dead accounts — hide those and title-case real names. Shared by
// the customers list and the account detail page so "who's the rep" always
// reads the same way.
export function repName(r: Restaurant): string | null {
  const raw = (r.customerAccountManager ?? "").trim();
  if (!raw || ["NONE", "INACTIVE", "CLOSED", "N/A", "-", "DOUBLE"].includes(raw.toUpperCase())) return null;
  return raw.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Power BI only ever supplies a rep via order history — an account with zero
// orders on record has nothing for any query to derive, ever (verified across
// the full data model). Lets someone type in who owns the account instead of
// leaving a permanent "—"; saved straight onto the venue.
export function EditableRep({ r }: { r: Restaurant }) {
  const { updateRestaurant } = useRestaurants();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  function save() {
    const trimmed = value.trim();
    updateRestaurant(r.id, { customerAccountManager: trimmed || undefined });
    setEditing(false);
  }

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="text-xs text-red-600 hover:underline">
        Set rep
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder="Rep name"
        onBlur={() => !value.trim() && setEditing(false)}
        className="w-24 rounded-md border border-slate-200 px-1.5 py-1 text-xs outline-none focus:border-brand-400"
      />
      <button onClick={save} className="text-xs font-semibold text-red-600">
        Save
      </button>
    </div>
  );
}

// Dead/invalid accounts stay listed as customers, but instead of a last-contact
// date they show WHY nobody is contacting them: the account status Power BI
// put in the account-manager field.
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  CLOSED: "Closed",
  INACTIVE: "Inactive",
  DOUBLE: "Duplicate",
};

export function accountStatus(r: Restaurant): string | null {
  const raw = (r.customerAccountManager ?? "").trim().toUpperCase();
  return ACCOUNT_STATUS_LABELS[raw] ?? null;
}

export function AccountStatusChip({ label }: { label: string }) {
  const style = label === "Closed" ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${style}`}>{label}</span>;
}
