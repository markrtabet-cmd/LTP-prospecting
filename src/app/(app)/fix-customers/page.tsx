"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, MapPin, Search, Link2, Plus, X, Loader2, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { REASON_HINT, REASON_LABEL, type UnmatchedCustomer, type UnmatchedReason } from "@/lib/customer-fix";
import { isRelevantSector } from "@/lib/sectors";
import { repForVenue } from "@/lib/visits/schedule";
import type { Rep, Restaurant } from "@/lib/types";

const REASON_STYLE: Record<UnmatchedReason, string> = {
  ambiguous: "bg-amber-100 text-amber-800",
  no_match: "bg-emerald-100 text-emerald-800",
  postcode_unresolved: "bg-rose-100 text-rose-800",
  no_postcode: "bg-rose-100 text-rose-800",
};

// Postcode comparison for the link flow — uppercase, all whitespace stripped.
const normPc = (s?: string) => (s || "").toUpperCase().replace(/\s+/g, "");

async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; item?: UnmatchedCustomer }> {
  const res = await fetch("/api/customers-to-fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

function FixCard({ item, onResolved, onUpdated, readOnly }: { item: UnmatchedCustomer; onResolved: (id: string) => void; onUpdated: (item: UnmatchedCustomer) => void; readOnly?: boolean }) {
  const { restaurants } = useRestaurants();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  // "Edit details" lets an admin correct the venue's postcode / name / address —
  // e.g. a wrong Power BI postcode. Seeded from the fix row; only changed fields
  // are sent, so an edited postcode re-geocodes. "Save changes" persists the
  // correction on this row (the hourly sync re-applies it); "Add as new
  // customer" applies any unsaved edits too.
  const [showEdit, setShowEdit] = useState(false);
  const [edit, setEdit] = useState({ name: item.name, postcode: item.postcode ?? "", address: item.address ?? "" });
  const [saved, setSaved] = useState(false);
  // A venue the user clicked to link whose postcode differs from Power BI's — we
  // ask which location the pin should take before committing. Null = nothing
  // pending. When postcodes agree (or Power BI has none) we link immediately.
  const [pendingLink, setPendingLink] = useState<{ venueId: string; name: string; postcode: string } | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as Restaurant[];
    const out: Restaurant[] = [];
    for (const r of restaurants) {
      if (`${r.name} ${r.postcode} ${r.borough}`.toLowerCase().includes(q)) {
        out.push(r);
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [query, restaurants]);

  async function run(label: string, body: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    const r = await postAction({ id: item.id, ...body });
    setBusy(null);
    if (r.ok) onResolved(item.id);
    else setError(r.error === "no-location" ? "No location for this customer — use Edit details to correct its postcode, or link it to a venue." : r.error ?? "Something went wrong");
  }

  // Save the edit WITHOUT resolving the card: the row updates in place (postcode
  // chip, reason badge) and the correction survives the hourly sync.
  async function runSave() {
    setBusy("edit");
    setError(null);
    const r = await postAction({ id: item.id, action: "edit", ...changedFields() });
    setBusy(null);
    if (r.ok && r.item) {
      setSaved(true);
      onUpdated(r.item);
    } else {
      setError(r.error ?? "Something went wrong");
    }
  }

  // Clicking a venue to link: if its postcode matches Power BI's (or Power BI has
  // none) link straight away keeping the existing venue's location; otherwise ask
  // which postcode the pin should use.
  function chooseLink(venueId: string, name: string, postcode: string) {
    const custPc = normPc(item.postcode);
    if (!custPc || custPc === normPc(postcode)) {
      run(`link-${venueId}`, { action: "link", venueId, locationSource: "existing" });
    } else {
      setError(null);
      setPendingLink({ venueId, name, postcode });
    }
  }

  // Keep the prompt mounted while the link POSTs so its button shows the in-flight
  // spinner; a success unmounts the whole card via onResolved, an error leaves the
  // prompt up (with the error) to retry or cancel.
  function commitLink(locationSource: "existing" | "powerbi") {
    if (!pendingLink) return;
    run(`link-${pendingLink.venueId}`, { action: "link", venueId: pendingLink.venueId, locationSource });
  }

  const hasLocation = item.latitude != null && item.longitude != null;
  // Only send fields the admin actually changed, so an untouched Save/Add
  // behaves exactly as before (Power BI name + geocoded postcode).
  const postcodeEdited = edit.postcode.trim() !== (item.postcode ?? "").trim();
  function changedFields(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (edit.name.trim() && edit.name.trim() !== item.name) b.name = edit.name.trim();
    if (postcodeEdited) b.postcode = edit.postcode.trim();
    if (edit.address.trim() !== (item.address ?? "").trim()) b.address = edit.address.trim();
    return b;
  }
  const dirty = Object.keys(changedFields()).length > 0;
  function setEditField(patch: Partial<typeof edit>) {
    setSaved(false);
    setEdit((s) => ({ ...s, ...patch }));
  }

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="truncate">{item.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${REASON_STYLE[item.reason]}`}>
              {REASON_LABEL[item.reason]}
            </span>
            {item.active === false && (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Inactive</span>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
            {item.postcode ? <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{item.postcode}</span> : <span className="text-rose-500">no postcode</span>}
            {item.district && <span>{item.district}</span>}
            {item.sector && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{item.sector}</span>}
            {item.accountCode && <span>acct {item.accountCode}</span>}
            {item.accountManager && <span>rep: {item.accountManager}</span>}
          </p>
          {(item.contactName || item.phone || item.email) && (
            <p className="mt-0.5 text-xs text-slate-400">
              {[item.contactName, item.phone, item.email].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-500">{REASON_HINT[item.reason]}</p>

      {/* Postcode choice — only when the venue just clicked sits at a different
          postcode than Power BI, so the rep decides where the pin lands. */}
      {!readOnly && pendingLink && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
          <p className="text-xs text-amber-900">
            <b>{pendingLink.name}</b> is at <b>{pendingLink.postcode || "no postcode"}</b>, but Power BI has <b>{item.postcode}</b>. Which postcode should the pin use?
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              disabled={!!busy}
              onClick={() => commitLink("existing")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy === `link-${pendingLink.venueId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
              Keep venue{pendingLink.postcode ? ` (${pendingLink.postcode})` : ""}
            </button>
            <button
              disabled={!!busy}
              onClick={() => commitLink("powerbi")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {busy === `link-${pendingLink.venueId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
              Use Power BI ({item.postcode})
            </button>
            <button
              disabled={!!busy}
              onClick={() => setPendingLink(null)}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Suggested existing venues to link (avoids a duplicate pin) */}
      {item.suggestions.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Looks like</p>
          <div className="flex flex-wrap gap-2">
            {item.suggestions.map((s) =>
              readOnly ? (
                <span key={s.venueId} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 ring-1 ring-slate-200">
                  {s.name} <span className="text-slate-400">· {s.postcode}</span>
                </span>
              ) : (
                <button
                  key={s.venueId}
                  disabled={!!busy}
                  onClick={() => chooseLink(s.venueId, s.name, s.postcode)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100 disabled:opacity-50"
                >
                  {busy === `link-${s.venueId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                  Link to {s.name} <span className="text-brand-400">· {s.postcode}</span>
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {readOnly && (
        <p className="mt-3 text-xs text-slate-400">One of your Power BI customers isn&rsquo;t on the map yet — an admin will add it.</p>
      )}

      {/* Actions (admins only — reps see their gaps read-only) */}
      {!readOnly && (
      <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowSearch((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
        >
          <Search className="h-3.5 w-3.5" /> Link to another venue
        </button>
        <button
          onClick={() => setShowEdit((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 hover:bg-slate-50 ${showEdit ? "bg-slate-100 text-slate-700 ring-slate-300" : "bg-white text-slate-600 ring-slate-200"}`}
        >
          <Pencil className="h-3.5 w-3.5" /> Edit details
        </button>
        <button
          disabled={!!busy}
          onClick={() => run("add", { action: "add", ...changedFields() })}
          title={postcodeEdited ? "Add with the edited postcode (re-geocoded)" : hasLocation ? "Add as a new customer pin" : "Will try to geocode the postcode"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add as new customer
        </button>
        <button
          disabled={!!busy}
          onClick={() => run("dismiss", { action: "dismiss" })}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-700 disabled:opacity-50"
        >
          {busy === "dismiss" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Ignore
        </button>
      </div>

      {showEdit && (
        <div className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200 sm:grid-cols-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-slate-500">Name</span>
            <input value={edit.name} onChange={(e) => setEditField({ name: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-400" />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-slate-500">Postcode {postcodeEdited && <span className="text-brand-600">· will re-geocode</span>}</span>
            <input value={edit.postcode} onChange={(e) => setEditField({ postcode: e.target.value })}
              placeholder="e.g. SW11 3BW"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-400" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-0.5 block text-[11px] font-medium text-slate-500">Address (optional)</span>
            <input value={edit.address} onChange={(e) => setEditField({ address: e.target.value })}
              placeholder="Street address"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-400" />
          </label>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button
              disabled={!!busy || !dirty}
              onClick={runSave}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {busy === "edit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save changes
            </button>
            {saved && !dirty && <span className="text-[11px] font-medium text-emerald-600">Saved — the hourly sync keeps this correction.</span>}
          </div>
          <p className="text-[11px] text-slate-400 sm:col-span-2"><b>Save changes</b> updates this row — an edited postcode re-geocodes it. <b>Add as new customer</b> creates the map pin.</p>
        </div>
      )}

      {showSearch && (
        <div className="mt-2 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search venues by name or postcode…"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
          />
          {results.length > 0 && (
            <ul className="mt-1 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-white ring-1 ring-slate-200">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    disabled={!!busy}
                    onClick={() => chooseLink(r.id, r.name, r.postcode)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-slate-800">{r.name}</span>
                      {r.existingCustomer && <span className="ml-2 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">Customer</span>}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{r.borough} · {r.postcode}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </>
      )}

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

const REASON_ORDER: UnmatchedReason[] = ["ambiguous", "no_match", "postcode_unresolved", "no_postcode"];

function ownsFixRow(item: UnmatchedCustomer, meId: string | undefined, reps: Rep[]): boolean {
  if (!meId || !item.accountManager) return false;
  return repForVenue({ customerAccountManager: item.accountManager } as Restaurant, reps)?.id === meId;
}

export default function FixCustomersPage() {
  const { me, reps, seesEverything, loading: repLoading } = useRep();
  const { refresh } = useRestaurants();
  const [items, setItems] = useState<UnmatchedCustomer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<UnmatchedReason | "all">("all");
  // Default ON: reps only care about active customers in sectors they serve —
  // toggle either off to also see dormant / off-target accounts.
  const [hideInactive, setHideInactive] = useState(true);
  const [hideIrrelevant, setHideIrrelevant] = useState(true);

  useEffect(() => {
    if (repLoading) return;
    let alive = true;
    fetch("/api/customers-to-fix")
      .then((r) => r.json())
      .then((d: { ok: boolean; items?: UnmatchedCustomer[]; error?: string }) => {
        if (!alive) return;
        if (d.ok) setItems(d.items ?? []);
        else setLoadError(d.error ?? "Failed to load");
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => { alive = false; };
  }, [repLoading]);

  const onResolved = (id: string) => {
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    // Pull the just-written add/link into the shared store so the new customer
    // shows on the map + Customers page immediately, not after the focus/2-min refresh.
    refresh();
  };

  // A saved edit keeps the card on the list but refreshes its row (postcode
  // chip, reason badge, coordinates) from the server's re-geocoded copy.
  const onUpdated = (item: UnmatchedCustomer) => {
    setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? item : i)) : prev));
  };

  // Reps only see the customers logged as theirs in Power BI (account-manager
  // match); admins/devs see everyone.
  const roleItems = useMemo(() => {
    const list = items ?? [];
    return seesEverything ? list : list.filter((i) => ownsFixRow(i, me?.id, reps));
  }, [items, seesEverything, me?.id, reps]);

  // Then apply the hide toggles.
  const scopedItems = useMemo(() => {
    let list = roleItems;
    if (hideInactive) list = list.filter((i) => i.active !== false);
    if (hideIrrelevant) list = list.filter((i) => isRelevantSector(i.sector));
    return list;
  }, [roleItems, hideInactive, hideIrrelevant]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of scopedItems) c[i.reason] = (c[i.reason] ?? 0) + 1;
    return c;
  }, [scopedItems]);

  const shown = useMemo(
    () => scopedItems.filter((i) => filter === "all" || i.reason === filter),
    [scopedItems, filter],
  );

  return (
    <div>
      <PageHeader
        title="Customers to fix"
        subtitle="Power BI customers the automatic sync couldn't place on the map — link each to its venue, or add it as new"
      />

      {loadError && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{loadError}. If this is the first run, create the <code className="rounded bg-rose-100 px-1">ltp_unmatched_customers</code> table (see supabase-schema.sql) and run the customer sync.</span>
        </div>
      )}

      {items === null && !loadError && (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      )}

      {items !== null && roleItems.length === 0 && !loadError && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-6 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <Check className="h-5 w-5" />
          {seesEverything ? "Every Power BI customer is matched to a venue. Nothing to fix." : "None of your customers need fixing — they're all on the map."}
          <Link href="/customers" className="font-semibold underline">View customers</Link>
        </div>
      )}

      {items !== null && roleItems.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All (${scopedItems.length})`} />
            {REASON_ORDER.filter((r) => counts[r]).map((r) => (
              <FilterChip key={r} active={filter === r} onClick={() => setFilter(r)} label={`${REASON_LABEL[r]} (${counts[r]})`} />
            ))}
          </div>
          <div className="mb-4 flex flex-wrap gap-4">
            <ToggleChip on={hideInactive} onChange={setHideInactive} label="Hide inactive" />
            <ToggleChip on={hideIrrelevant} onChange={setHideIrrelevant} label="Hide irrelevant sectors" />
          </div>
          <div className="space-y-3">
            {shown.length === 0 ? (
              <p className="rounded-xl bg-white p-6 text-sm text-slate-400 ring-1 ring-slate-200">No customers match these filters.</p>
            ) : (
              shown.map((item) => (
                <FixCard key={item.id} item={item} onResolved={onResolved} onUpdated={onUpdated} readOnly={!seesEverything} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ToggleChip({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button onClick={() => onChange(!on)} className="flex items-center gap-2 text-sm text-slate-600">
      <span className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${on ? "bg-brand-500" : "bg-slate-200"}`}>
        <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
      </span>
      {label}
    </button>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-brand-500 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );
}
