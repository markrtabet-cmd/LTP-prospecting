"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CalendarClock, PhoneCall, Sparkles, type LucideIcon } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { venuesForRep } from "@/lib/visits/schedule";
import { detectAllSalesAlerts, type SalesAlert } from "@/lib/visits/sales-health";
import { toDateKey } from "@/lib/visits/dates";
import type { Restaurant } from "@/lib/types";

// The dashboard's personal digest: what THIS rep should do this week and how
// THEIR own accounts are doing — micro and per-rep, not whole-business.
// Everything is derived client-side from the rep's own book (accounts matched
// to them, their scheduled visits, and new openings in their patch), so it's
// always fresh and needs no weekly compute.

type ActionKind = "visit" | "check_in" | "opening";

const KIND_META: Record<ActionKind, { icon: LucideIcon; chip: string }> = {
  visit: { icon: CalendarClock, chip: "bg-blue-50 text-blue-600" },
  check_in: { icon: PhoneCall, chip: "bg-brand-50 text-brand-600" },
  opening: { icon: Sparkles, chip: "bg-amber-50 text-amber-600" },
};

interface Action {
  kind: ActionKind;
  venueId: string;
  venue: string;
  reason: string;
  urgent?: boolean;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function RepDigest() {
  const { restaurants } = useRestaurants();
  const { meetings } = useMeetings();
  const { me, reps, loading } = useRep();

  // Whose week: the signed-in rep, falling back to Stefano (or the first rep on
  // the roster) so the personalised view is visible before per-rep sign-in is
  // wired everywhere.
  const rep = useMemo(() => {
    if (me) return reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] };
    return reps.find((r) => /stefano/i.test(r.name)) ?? reps[0] ?? null;
  }, [me, reps]);
  const viewingFallback = !me && !!rep;

  const todayKey = toDateKey(new Date());

  const myCustomers = useMemo(
    () => (rep ? venuesForRep(restaurants, rep, reps).filter((v) => v.existingCustomer) : []),
    [restaurants, rep, reps],
  );

  // Accounts with a sales signal worth acting on, worst first.
  const slipping = useMemo(() => {
    const rank = (s: SalesAlert["severity"]) => (s === "high" ? 0 : 1);
    return myCustomers
      .map((c) => ({ venue: c, alert: detectAllSalesAlerts(c.salesHistory)[0] as SalesAlert | undefined }))
      .filter((x): x is { venue: Restaurant; alert: SalesAlert } => Boolean(x.alert))
      .sort((a, b) => rank(a.alert.severity) - rank(b.alert.severity));
  }, [myCustomers]);

  const myScheduled = useMemo(
    () => meetings.filter((m) => m.repId === rep?.id && m.status === "scheduled"),
    [meetings, rep],
  );
  const dueVisits = useMemo(
    () =>
      myScheduled
        .filter((m) => toDateKey(new Date(m.date)) <= todayKey)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [myScheduled, todayKey],
  );

  // New openings in the rep's patch (their customers' boroughs).
  const patchOpenings = useMemo(() => {
    const boroughs = new Set(myCustomers.map((c) => c.borough));
    if (!boroughs.size) return [];
    return restaurants
      .filter(
        (r) =>
          (r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") &&
          !r.excluded &&
          boroughs.has(r.borough),
      )
      .slice(0, 3);
  }, [restaurants, myCustomers]);

  const actions = useMemo<Action[]>(() => {
    const out: Action[] = [];
    for (const m of dueVisits.slice(0, 3)) {
      const overdue = toDateKey(new Date(m.date)) < todayKey;
      out.push({
        kind: "visit",
        venueId: m.venueId,
        venue: m.venueName,
        reason: overdue ? "Visit overdue — reschedule or log it" : "Visit booked for today",
        urgent: overdue,
      });
    }
    for (const s of slipping.slice(0, 3)) {
      out.push({
        kind: "check_in",
        venueId: s.venue.id,
        venue: s.venue.name,
        reason: s.alert.detail,
        urgent: s.alert.severity === "high",
      });
    }
    for (const o of patchOpenings) {
      out.push({ kind: "opening", venueId: o.id, venue: o.name, reason: `Just opened in ${o.borough} — worth a look` });
    }
    return out.slice(0, 6);
  }, [dueVisits, slipping, patchOpenings, todayKey]);

  if (loading) return null;

  if (!rep) {
    return (
      <div className="anim-rise mt-6 rounded-xl bg-white p-5 shadow-sm" style={{ "--rise-delay": "520ms" } as React.CSSProperties}>
        <h2 className="text-base font-semibold tracking-[-0.01em] text-slate-900">Your week</h2>
        <p className="mt-1 text-sm text-slate-500">Sign in as a rep to see your accounts, visits, and follow-ups here.</p>
      </div>
    );
  }

  const needAttention = slipping.length;
  const stats = [
    { label: "Your accounts", value: myCustomers.length },
    { label: "Need a nudge", value: needAttention, accent: needAttention > 0 ? "text-brand-600" : "text-slate-900" },
    { label: "Visits booked", value: myScheduled.length, accent: "text-blue-600" },
  ];

  return (
    <div className="anim-rise mt-6" style={{ "--rise-delay": "520ms" } as React.CSSProperties}>
      {/* Personalised header */}
      <div className="mb-3 flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500 text-sm font-semibold text-white">
          {initials(rep.name)}
        </span>
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-slate-900">
            {firstName(rep.name)}&rsquo;s week
            {viewingFallback && (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">preview</span>
            )}
          </h2>
          <p className="text-xs text-slate-400">What needs you, and how your accounts are doing</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Do this week */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Do this week</h3>
          {actions.length === 0 ? (
            <div className="rounded-lg bg-slate-50 px-3 py-4 text-center">
              <p className="text-sm font-medium text-slate-600">You&rsquo;re all caught up</p>
              <p className="mt-0.5 text-xs text-slate-400">Nothing pressing across your accounts today.</p>
            </div>
          ) : (
            <ul className="-mx-1 space-y-0.5">
              {actions.map((a, i) => {
                const meta = KIND_META[a.kind];
                const Icon = meta.icon;
                return (
                  <li key={`${a.venueId}-${i}`} className="flex items-start gap-3 rounded-lg px-1 py-2 transition-colors duration-150 hover:bg-slate-50">
                    <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.chip}`}>
                      <Icon size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link href={`/restaurants/${a.venueId}`} className="block truncate text-sm font-medium text-slate-800 transition-colors duration-150 hover:text-brand-600">
                        {a.venue}
                      </Link>
                      <p className="text-xs leading-snug text-slate-500">{a.reason}</p>
                    </div>
                    {a.urgent && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" title="Worth doing first" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Your accounts at a glance */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Your accounts at a glance</h3>
          <div className="grid grid-cols-3 gap-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-lg bg-slate-50 px-2 py-3 text-center">
                <p className={`text-2xl font-semibold leading-none tracking-[-0.02em] [font-variant-numeric:tabular-nums] ${s.accent ?? "text-slate-900"}`}>
                  {s.value}
                </p>
                <p className="mt-1.5 text-[11px] font-medium text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-slate-600">
            {myCustomers.length === 0 ? (
              <>No accounts are matched to you yet.</>
            ) : needAttention === 0 ? (
              <>Your book looks healthy — everyone&rsquo;s ordering as expected.</>
            ) : (
              <>
                {needAttention} of your {myCustomers.length} account{myCustomers.length === 1 ? "" : "s"}{" "}
                {needAttention === 1 ? "needs" : "need"} a check-in. Start with the ones flagged on the left.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
