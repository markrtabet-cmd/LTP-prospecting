"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ChainBadge, InactiveBadge, PriceTag } from "@/components/StatusBadge";
import { AccountStatusChip, EditableRep, accountStatus, repName } from "@/components/RepCell";
import { useRestaurants } from "@/lib/store";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { ownsCustomer } from "@/lib/ownership";
import { FitText } from "@/components/FitText";
import { detectChain, groupChains, type ChainGroup } from "@/lib/chains";
import { computeVenueSchedule } from "@/lib/visits/schedule";
import { humanIntervalLabel } from "@/lib/visits/interval";
import { INACTIVE_AFTER_MONTHS, isCustomerActive } from "@/lib/customer-activity";
import type { Meeting, Restaurant } from "@/lib/types";

// Their usual visit cadence, from the same rhythm engine the calendar uses —
// "Paused" when the rep's turned off reminders, "—" before there's enough
// history to say anything yet.
function rhythmLabel(r: Restaurant, meetings: Meeting[]): string {
  const { schedule } = computeVenueSchedule(r, meetings);
  if (schedule.reminderState === "paused") return "Paused";
  if (schedule.effectiveIntervalDays == null) return "—";
  return humanIntervalLabel(schedule.effectiveIntervalDays);
}

export default function CustomersPage() {
  const { restaurants, updateRestaurant, removeRestaurant } = useRestaurants();
  const { meetings } = useMeetings();
  const { me, reps, salesReps, seesEverything } = useRep();
  const [q, setQ] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [repFilter, setRepFilter] = useState(""); // admin/dev: filter by one rep
  const [activityFilter, setActivityFilter] = useState<"active" | "all" | "inactive">("active");
  const [sectorFilter, setSectorFilter] = useState("all"); // "all" | a specific sector

  function removeCustomer(id: string) {
    // Manually-added records are removed entirely; real FSA venues are just
    // un-flagged so they return to the prospect pool.
    if (id.startsWith("r-user-")) removeRestaurant(id);
    else updateRestaurant(id, { existingCustomer: false, outreachStatus: "not_contacted" });
  }

  // A rep sees only their own accounts (Power BI account-manager match). Admins
  // and developers see everyone, and can drill into one rep via the dropdown.
  const meRep = useMemo(
    () => (me ? reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null),
    [me, reps],
  );
  // Everyone this viewer is allowed to see (before the active/inactive filter),
  // so the "N inactive hidden" count stays accurate.
  const scopedCustomers = useMemo(() => {
    const custs = restaurants.filter((r) => r.existingCustomer);
    if (!seesEverything) return meRep ? custs.filter((r) => ownsCustomer(r, meRep, reps)) : [];
    if (repFilter) {
      const fr = reps.find((x) => x.id === repFilter);
      return fr ? custs.filter((r) => ownsCustomer(r, fr, reps)) : custs;
    }
    return custs;
  }, [restaurants, meRep, reps, seesEverything, repFilter]);

  // Sectors present in this viewer's book, for the sector dropdown.
  const sectorsPresent = useMemo(
    () => Array.from(new Set(scopedCustomers.map((r) => r.sector).filter((s): s is string => !!s))).sort(),
    [scopedCustomers],
  );
  // Sector scope applied before the activity filter, so the active/inactive
  // counts reflect the sectors currently shown.
  const sectorScoped = useMemo(() => {
    if (sectorFilter === "all") return scopedCustomers;
    return scopedCustomers.filter((r) => r.sector === sectorFilter);
  }, [scopedCustomers, sectorFilter]);

  const inactiveCount = useMemo(
    () => sectorScoped.filter((r) => !isCustomerActive(r)).length,
    [sectorScoped],
  );
  const activeCount = sectorScoped.length - inactiveCount;

  const allCustomers = useMemo(() => {
    if (activityFilter === "all") return sectorScoped;
    if (activityFilter === "inactive") return sectorScoped.filter((r) => !isCustomerActive(r));
    return sectorScoped.filter((r) => isCustomerActive(r));
  }, [sectorScoped, activityFilter]);

  const rhythmByVenueId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allCustomers) map.set(r.id, rhythmLabel(r, meetings));
    return map;
  }, [allCustomers, meetings]);

  const ql = q.trim().toLowerCase();
  const matches = (r: Restaurant) =>
    `${r.name} ${r.borough} ${r.cuisineType}`.toLowerCase().includes(ql);

  // Full grouping (unfiltered) drives the headline counts.
  const groups = useMemo(() => groupChains(allCustomers), [allCustomers]);
  const businesses = groups.length;
  const chainCount = groups.filter((g) => g.isChain).length;

  // Groups shown in the table: when searching, keep only matching members and
  // force the matching chains open.
  const visibleGroups = useMemo<ChainGroup[]>(() => {
    if (!ql) return groups;
    return groups
      .map((g) => ({ ...g, members: g.members.filter(matches) }))
      .filter((g) => g.members.length > 0);
  }, [groups, ql]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat list (when grouping is toggled off).
  const flat = useMemo(() => {
    const list = ql ? allCustomers.filter(matches) : allCustomers;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [allCustomers, ql]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOpen = (key: string) => ql !== "" || open.has(key);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const subtitle =
    businesses === allCustomers.length
      ? `${allCustomers.length} restaurant${allCustomers.length === 1 ? "" : "s"} already buying from La Tua Pasta`
      : `${allCustomers.length} customer locations · ${businesses} businesses after grouping ${chainCount} chain${chainCount === 1 ? "" : "s"}`;

  return (
    <div>
      <PageHeader
        title="Existing customers"
        subtitle={subtitle}
      />

      {scopedCustomers.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">No customers yet.</p>
          <p className="mt-1 text-xs text-slate-400">
            Customers sync automatically from Power BI every night — the first sync will fill this page.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500" />
            {seesEverything && (
              <select
                value={repFilter}
                onChange={(e) => setRepFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">All reps</option>
                {salesReps.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500" />
              Group chains &amp; duplicates
            </label>
            <select
              value={activityFilter}
              onChange={(e) => setActivityFilter(e.target.value as "active" | "all" | "inactive")}
              title={`Inactive = no order in the last ${INACTIVE_AFTER_MONTHS} months (override per customer on their profile)`}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="active">Only active ({activeCount})</option>
              <option value="all">All customers ({sectorScoped.length})</option>
              <option value="inactive">Only inactive ({inactiveCount})</option>
            </select>
            <select
              value={sectorFilter}
              onChange={(e) => setSectorFilter(e.target.value)}
              title="Filter customers by their Power BI sector"
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="all">All sectors</option>
              {sectorsPresent.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {allCustomers.length === 0 ? (
            <div className="rounded-xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
              <p className="text-sm text-slate-500">
                {activityFilter === "inactive"
                  ? "No inactive customers — everyone has ordered recently."
                  : "No active customers to show."}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Switch the filter above to see {activityFilter === "inactive" ? "everyone" : "all customers"}.
              </p>
            </div>
          ) : (
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Restaurant</th>
                  <th className="px-4 py-3">Sector</th>
                  <th className="px-4 py-3">Borough</th>
                  <th className="px-4 py-3">Cuisine</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Sales rep</th>
                  <th className="px-4 py-3">Last contacted</th>
                  <th className="px-4 py-3">Visit rhythm</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {grouped
                  ? visibleGroups.map((g) =>
                      g.members.length > 1 ? (
                        <ChainRows
                          key={g.key}
                          group={g}
                          open={isOpen(g.key)}
                          onToggle={() => toggle(g.key)}
                          onRemove={removeCustomer}
                          rhythmByVenueId={rhythmByVenueId}
                        />
                      ) : (
                        <CustomerRow
                          key={g.members[0].id}
                          r={g.members[0]}
                          onRemove={removeCustomer}
                          rhythm={rhythmByVenueId.get(g.members[0].id) ?? "—"}
                        />
                      )
                    )
                  : flat.map((r) => (
                      <CustomerRow key={r.id} r={r} onRemove={removeCustomer} rhythm={rhythmByVenueId.get(r.id) ?? "—"} />
                    ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </div>
  );
}

function ChainRows({
  group,
  open,
  onToggle,
  onRemove,
  rhythmByVenueId,
}: {
  group: ChainGroup;
  open: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  rhythmByVenueId: Map<string, string>;
}) {
  const boroughs = Array.from(new Set(group.members.map((m) => m.borough)));
  const sectors = Array.from(new Set(group.members.map((m) => m.sector).filter((s): s is string => Boolean(s))));
  const cuisine = mode(group.members.map((m) => m.cuisineType));
  const reps = Array.from(new Set(group.members.map(repName).filter((x): x is string => Boolean(x))));
  const lastTs = group.members.reduce<number | null>((acc, m) => {
    const t = lastContactTs(m);
    return t !== null && (acc === null || t > acc) ? t : acc;
  }, null);
  // Whole-chain status only when every location shares it (e.g. all Closed).
  const statuses = Array.from(new Set(group.members.map(accountStatus)));
  const chainStatus = statuses.length === 1 ? statuses[0] : null;
  const rhythms = Array.from(new Set(group.members.map((m) => rhythmByVenueId.get(m.id) ?? "—")));
  return (
    <>
      <tr className="cursor-pointer bg-slate-50/60 hover:bg-slate-100" onClick={onToggle}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
            <span className="font-semibold text-slate-800">{group.name}</span>
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
              {group.members.length} locations
            </span>
          </div>
        </td>
        <td className="px-4 py-3">
          {sectors.length === 1 ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{sectors[0]}</span>
          ) : sectors.length > 1 ? (
            <span className="text-xs text-slate-400">Mixed</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-slate-600">
          {boroughs.length === 1 ? boroughs[0] : `${boroughs.length} boroughs`}
        </td>
        <td className="px-4 py-3 text-slate-600">{cuisine}</td>
        <td className="px-4 py-3 text-slate-400">—</td>
        <td className="px-4 py-3 text-slate-600">
          {reps.length === 1 ? reps[0] : reps.length > 1 ? `${reps.length} reps` : <span className="text-slate-400">—</span>}
        </td>
        <td className="px-4 py-3">
          {chainStatus ? <AccountStatusChip label={chainStatus} /> : <LastContacted ts={lastTs} />}
        </td>
        <td className="px-4 py-3 text-slate-600">
          {rhythms.length === 1 ? rhythms[0] : <span className="text-slate-400">Mixed</span>}
        </td>
        <td className="px-4 py-3 text-right text-xs text-slate-400">{open ? "Collapse" : "Expand"}</td>
      </tr>
      {open &&
        group.members.map((r) => (
          <CustomerRow key={r.id} r={r} onRemove={onRemove} nested rhythm={rhythmByVenueId.get(r.id) ?? "—"} />
        ))}
    </>
  );
}

function CustomerRow({
  r,
  onRemove,
  nested,
  rhythm,
}: {
  r: Restaurant;
  onRemove: (id: string) => void;
  nested?: boolean;
  rhythm: string;
}) {
  return (
    <tr className="hover:bg-slate-50">
      <td className={`px-4 py-3 ${nested ? "pl-12" : ""}`}>
        <Link href={`/restaurants/${r.id}`} className="font-medium text-slate-800 hover:text-brand-600"><FitText maxWidth={240} title={r.name}>{r.name}</FitText></Link>
        {!isCustomerActive(r) && <span className="ml-2 align-middle"><InactiveBadge /></span>}
        {!nested && detectChain(r.name) && <span className="ml-2 align-middle"><ChainBadge brand={detectChain(r.name)!} /></span>}
        {(r.contactLog?.length ?? 0) > 0 && (
          <span className="ml-2 align-middle text-xs text-slate-400" title={`${r.contactLog!.length} contact note(s)`}>
            🗒 {r.contactLog!.length}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {r.sector ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{r.sector}</span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-slate-600"><FitText maxWidth={150} title={r.borough}>{r.borough}</FitText></td>
      <td className="px-4 py-3 text-slate-600"><FitText maxWidth={150} title={r.cuisineType}>{r.cuisineType}</FitText></td>
      <td className="px-4 py-3"><PriceTag tier={r.priceTier} /></td>
      <td className="px-4 py-3 text-slate-600">{repName(r) ? repName(r) : <EditableRep r={r} />}</td>
      <td className="px-4 py-3">
        {accountStatus(r) ? <AccountStatusChip label={accountStatus(r)!} /> : <LastContacted ts={lastContactTs(r)} />}
      </td>
      <td className="px-4 py-3 text-slate-600">{rhythm}</td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={() => onRemove(r.id)}
          className="text-xs font-medium text-slate-400 hover:text-red-600"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

// Latest logged-activity timestamp (ms) for a venue, or null if never contacted.
function lastContactTs(r: Restaurant): number | null {
  let max: number | null = null;
  for (const n of r.contactLog ?? []) {
    const t = Date.parse(n.at);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

function agoLabel(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 31) { const w = Math.round(days / 7); return `${w} week${w === 1 ? "" : "s"} ago`; }
  if (days < 365) { const m = Math.round(days / 30.44); return `${m} month${m === 1 ? "" : "s"} ago`; }
  const y = Math.floor(days / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

function LastContacted({ ts }: { ts: number | null }) {
  if (ts === null) return <span className="text-xs text-slate-400">Never</span>;
  const stale = Date.now() - ts > 45 * 86400000;
  return (
    <span
      title={new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
      className={`text-xs font-medium ${stale ? "text-amber-600" : "text-slate-600"}`}
    >
      {agoLabel(ts)}
    </span>
  );
}

// Most common value in a list (for a chain's representative cuisine).
function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? "—";
  let bestN = 0;
  Array.from(counts.entries()).forEach(([v, n]) => {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  });
  return best;
}
