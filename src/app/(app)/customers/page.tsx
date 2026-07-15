"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ChainBadge, InactiveBadge, PriceTag } from "@/components/StatusBadge";
import { AccountStatusChip, EditableRep, accountStatus, repName } from "@/components/RepCell";
import { useRestaurants } from "@/lib/store";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { ownsCustomer } from "@/lib/ownership";
import { displayArea } from "@/lib/locations";
import { FitText } from "@/components/FitText";
import { detectChain, groupChains, type ChainGroup } from "@/lib/chains";
import { computeVenueSchedule } from "@/lib/visits/schedule";
import { humanIntervalLabel } from "@/lib/visits/interval";
import { INACTIVE_AFTER_MONTHS, inactivityReason, isCustomerActive, isNewCustomer30d } from "@/lib/customer-activity";
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
  const { restaurants, updateRestaurant, removeRestaurant, londonOnly } = useRestaurants();
  const { meetings } = useMeetings();
  const { reps, seesEverything, subjectRep } = useRep();
  const companyView = seesEverything && !subjectRep;
  const [q, setQ] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [activityFilter, setActivityFilter] = useState<"active" | "all" | "inactive">("active");
  const [sectorFilter, setSectorFilter] = useState("all"); // "all" | a specific sector
  // "New customers" KPI on the dashboard links here with ?new=1 to show only
  // customers acquired in the last ~30 days (read once, like the leads page).
  const [newOnly, setNewOnly] = useState(false);
  useEffect(() => {
    setNewOnly(new URLSearchParams(window.location.search).get("new") === "1");
  }, []);

  // --- Session view persistence -------------------------------------------
  // Restore the filters + list scroll when returning from a profile (or any
  // in-session revisit) so you land exactly where you were. Scroll targets the
  // shared <main> scroller from the app layout. Restore runs once on mount;
  // saving is skipped on that first pass so it can't clobber the stored view.
  const VIEW_KEY = "ltp-customers-view";
  const SCROLL_KEY = "ltp-customers-scroll";
  const skipSave = useRef(true);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(VIEW_KEY);
      if (raw) {
        const v = JSON.parse(raw) as Partial<{ q: string; grouped: boolean; open: string[]; repFilter: string; activityFilter: "active" | "all" | "inactive"; sectorFilter: string }>;
        if (typeof v.q === "string") setQ(v.q);
        if (typeof v.grouped === "boolean") setGrouped(v.grouped);
        if (Array.isArray(v.open)) setOpen(new Set(v.open));
        if (v.activityFilter) setActivityFilter(v.activityFilter);
        if (typeof v.sectorFilter === "string") setSectorFilter(v.sectorFilter);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (skipSave.current) { skipSave.current = false; return; }
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({ q, grouped, open: Array.from(open), activityFilter, sectorFilter }));
    } catch { /* ignore */ }
  }, [q, grouped, open, activityFilter, sectorFilter]);

  // Restore scroll once the list is tall enough to reach the saved offset (data
  // is already in memory on an in-app return; re-applies as it settles). No deps
  // → runs after each render until it lands, then stops. The target is captured
  // once (before the save listener can overwrite it) so a stray scroll can't
  // clobber it mid-restore.
  const scrollRestored = useRef(false);
  const targetScroll = useRef<number | null>(null);
  useEffect(() => {
    if (scrollRestored.current) return;
    const main = document.querySelector("main");
    if (!main) return;
    if (targetScroll.current === null) targetScroll.current = Number(sessionStorage.getItem(SCROLL_KEY) || 0);
    const saved = targetScroll.current;
    if (!saved) { scrollRestored.current = true; return; }
    if (main.scrollHeight - main.clientHeight >= saved) {
      main.scrollTop = saved;
      scrollRestored.current = true;
    }
  });
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { sessionStorage.setItem(SCROLL_KEY, String(Math.round(main.scrollTop))); } catch { /* ignore */ }
      });
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => { main.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  function removeCustomer(id: string) {
    // Manually-added records are removed entirely; real FSA venues are just
    // un-flagged so they return to the prospect pool.
    if (id.startsWith("r-user-")) removeRestaurant(id);
    else updateRestaurant(id, { existingCustomer: false, outreachStatus: "not_contacted" });
  }

  // A rep sees only their own accounts (Power BI account-manager match). Admins
  // and developers see everyone, and can drill into one rep via the dropdown.
  // Everyone this viewer is allowed to see (before the active/inactive filter),
  // so the "N inactive hidden" count stays accurate. Driven by the site-wide
  // switcher: a rep sees their own book, an admin the whole company or one
  // picked rep.
  const scopedCustomers = useMemo(() => {
    const custs = restaurants.filter((r) => r.existingCustomer);
    if (companyView) return custs;
    return subjectRep ? custs.filter((r) => ownsCustomer(r, subjectRep, reps)) : [];
  }, [restaurants, subjectRep, companyView, reps]);

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
    let list = sectorScoped;
    if (activityFilter === "inactive") list = list.filter((r) => !isCustomerActive(r));
    else if (activityFilter === "active") list = list.filter((r) => isCustomerActive(r));
    if (newOnly) list = list.filter((r) => isNewCustomer30d(r));
    return list;
  }, [sectorScoped, activityFilter, newOnly]);

  const rhythmByVenueId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allCustomers) map.set(r.id, rhythmLabel(r, meetings));
    return map;
  }, [allCustomers, meetings]);

  const ql = q.trim().toLowerCase();
  const qlNoSpace = ql.replace(/\s+/g, "");
  const matches = (r: Restaurant) => {
    const hay = `${r.name} ${r.borough} ${r.cuisineType} ${r.sector ?? ""} ${r.postcode}`.toLowerCase();
    if (hay.includes(ql)) return true;
    // Also match a postcode typed without its space ("sw1a1aa" → "SW1A 1AA").
    return qlNoSpace.length > 0 && r.postcode.toLowerCase().replace(/\s+/g, "").includes(qlNoSpace);
  };

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

  // The inactivity "Reason" column is only meaningful for inactive customers, so
  // it appears once the view includes them (All / Only inactive) and stays out
  // of the default active-only list.
  const showReason = activityFilter !== "active";

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
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, area, cuisine or postcode…" className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500" />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500" />
              Group chains &amp; duplicates
            </label>
            <select
              value={activityFilter}
              onChange={(e) => setActivityFilter(e.target.value as "active" | "all" | "inactive")}
              title={`Inactive = no order in the last ${INACTIVE_AFTER_MONTHS} months; a customer becomes active again as soon as they order`}
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

          {newOnly && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-green-50 px-4 py-2.5 text-sm text-green-800 ring-1 ring-green-200">
              <span className="font-semibold">New customers</span>
              <span className="text-green-700">· acquired in the last 30 days ({allCustomers.length})</span>
              <Link href="/customers" onClick={() => setNewOnly(false)} className="ml-auto text-xs font-semibold text-green-700 underline">
                Show all customers
              </Link>
            </div>
          )}

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
                  <th className="px-4 py-3">{londonOnly ? "Borough" : "Area"}</th>
                  <th className="px-4 py-3">Cuisine</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Sales rep</th>
                  <th className="px-4 py-3">Last contacted</th>
                  <th className="px-4 py-3">Visit rhythm</th>
                  {showReason && <th className="px-4 py-3" title="Why this customer is inactive — synced from Power BI, with a prompt to find out when it's not recorded yet">Reason</th>}
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
                          londonOnly={londonOnly}
                          showReason={showReason}
                        />
                      ) : (
                        <CustomerRow
                          key={g.members[0].id}
                          r={g.members[0]}
                          onRemove={removeCustomer}
                          rhythm={rhythmByVenueId.get(g.members[0].id) ?? "—"}
                          londonOnly={londonOnly}
                          showReason={showReason}
                        />
                      )
                    )
                  : flat.map((r) => (
                      <CustomerRow key={r.id} r={r} onRemove={removeCustomer} rhythm={rhythmByVenueId.get(r.id) ?? "—"} londonOnly={londonOnly} showReason={showReason} />
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
  londonOnly,
  showReason,
}: {
  group: ChainGroup;
  open: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  rhythmByVenueId: Map<string, string>;
  londonOnly: boolean;
  showReason: boolean;
}) {
  // Area shown = the borough for London customers, else the customer's own town
  // (e.g. "Weybridge" for a Surrey account) — see displayArea.
  const areas = Array.from(new Set(group.members.map((m) => displayArea(m))));
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
  const inactiveNoReason = group.members.filter((m) => !isCustomerActive(m) && !inactivityReason(m)).length;
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
          {areas.length === 1 ? areas[0] : `${areas.length} ${londonOnly ? "boroughs" : "areas"}`}
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
        {showReason && (
          <td className="px-4 py-3">
            {inactiveNoReason > 0 ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{inactiveNoReason} need reason</span>
            ) : (
              <span className="text-slate-300">—</span>
            )}
          </td>
        )}
        <td className="px-4 py-3 text-right text-xs text-slate-400">{open ? "Collapse" : "Expand"}</td>
      </tr>
      {open &&
        group.members.map((r) => (
          <CustomerRow key={r.id} r={r} onRemove={onRemove} nested rhythm={rhythmByVenueId.get(r.id) ?? "—"} londonOnly={londonOnly} showReason={showReason} />
        ))}
    </>
  );
}

function CustomerRow({
  r,
  onRemove,
  nested,
  rhythm,
  londonOnly,
  showReason,
}: {
  r: Restaurant;
  onRemove: (id: string) => void;
  nested?: boolean;
  rhythm: string;
  londonOnly: boolean;
  showReason: boolean;
}) {
  const area = displayArea(r);
  const reason = inactivityReason(r);
  return (
    <tr className="hover:bg-slate-50">
      <td className={`px-4 py-3 ${nested ? "pl-12" : ""}`}>
        <Link href={`/restaurants/${r.id}?from=customers`} className="font-medium text-slate-800 hover:text-brand-600"><FitText maxWidth={240} title={r.name}>{r.name}</FitText></Link>
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
      <td className="px-4 py-3 text-slate-600"><FitText maxWidth={150} title={area}>{area}</FitText></td>
      <td className="px-4 py-3 text-slate-600"><FitText maxWidth={150} title={r.cuisineType}>{r.cuisineType}</FitText></td>
      <td className="px-4 py-3"><PriceTag tier={r.priceTier} /></td>
      <td className="px-4 py-3 text-slate-600">{repName(r) ? repName(r) : <EditableRep r={r} />}</td>
      <td className="px-4 py-3">
        {accountStatus(r) ? <AccountStatusChip label={accountStatus(r)!} /> : <LastContacted ts={lastContactTs(r)} />}
      </td>
      <td className="px-4 py-3 text-slate-600">{rhythm}</td>
      {showReason && (
        <td className="px-4 py-3">
          {isCustomerActive(r) ? (
            <span className="text-slate-300">—</span>
          ) : reason ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600" title="Reason synced from Power BI">{reason}</span>
          ) : (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title="No reason on record — the calendar is prompting a visit to find out why">
              Not stated
            </span>
          )}
        </td>
      )}
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
