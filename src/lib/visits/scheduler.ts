// Auto-scheduler: silently arranges each rep's calendar so visit quotas are
// met with the least driving. Pure function — the useAutoSchedule hook feeds
// it store data and persists the result.
//
// How it plans, in plain English:
//   1. Sweep: scheduled meetings whose day has passed unlogged become "missed"
//      (their client immediately counts as due again).
//   2. Every client of this rep gets a due date from the reminder engine
//      (rep-set frequency blended with the learned rhythm).
//   3. Rep-created meetings and AI follow-up commitments are LOCKED anchors:
//      they stay exactly where they are and pull nearby work towards them.
//   4. Each due client is placed on a working day inside its flexibility
//      window, choosing the day that minimises detour (distance to that day's
//      existing stops) plus lateness. Days are capped; light days are left
//      light on purpose — that's prospecting time.
//   5. Placements are stable: a client already planned for a day keeps it
//      unless the picture materially changes ("flexible, not jumpy").

import type { Meeting, Rep, Restaurant } from "@/lib/types";
import {
  FLEX_DAYS_AFTER,
  FLEX_DAYS_BEFORE,
  LATENESS_COST_METERS_PER_DAY,
  MAX_VISITS_PER_DAY,
  NEW_DAY_COST_METERS,
  SCHEDULE_HORIZON_DAYS,
} from "./config";
import { addDays, dateKeyToIso, diffInDays, isWeekend, relativeDays, startOfDay, toDateKey } from "./dates";
import { computeVenueSchedule, venueHasVisitSignal } from "./schedule";

interface LatLng {
  lat: number;
  lng: number;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PlanResult {
  /** Fluid scheduler meetings for the horizon (replaces the previous plan). */
  plan: Meeting[];
  /** Ids of scheduled meetings whose day passed unlogged → mark "missed". */
  missedIds: string[];
}

/** Stable id: one fluid scheduler slot per rep+venue, so re-flows move the
 * date instead of piling up new rows. */
export function schedulerMeetingId(repId: string, venueId: string): string {
  return `sch_${repId}_${venueId}`;
}

export function planSchedule(args: {
  rep: Rep;
  /** The venues on this rep's calendar (see venuesForRep). */
  venues: Restaurant[];
  /** ALL meetings — filtered internally. */
  meetings: Meeting[];
  today?: Date;
}): PlanResult {
  const today = startOfDay(args.today ?? new Date());
  const todayKey = toDateKey(today);
  const repMeetings = args.meetings.filter((m) => m.repId === args.rep.id);

  // ---- 1. Missed sweep -------------------------------------------------------
  const missedIds = repMeetings
    .filter((m) => m.status === "scheduled" && toDateKey(new Date(m.date)) < todayKey)
    .map((m) => m.id);
  const missedSet = new Set(missedIds);

  // ---- 2. Working days in the horizon ---------------------------------------
  const workingDays: string[] = [];
  for (let i = 0; i < SCHEDULE_HORIZON_DAYS; i++) {
    const d = addDays(today, i);
    if (!isWeekend(d)) workingDays.push(toDateKey(d));
  }
  if (workingDays.length === 0) return { plan: [], missedIds };
  const horizonEnd = addDays(today, SCHEDULE_HORIZON_DAYS - 1);

  // ---- 3. Day loads seeded from locked anchors -------------------------------
  const venueById = new Map(args.venues.map((v) => [v.id, v]));
  const dayLoads = new Map<string, { points: LatLng[]; count: number }>();
  for (const key of workingDays) dayLoads.set(key, { points: [], count: 0 });

  // Venues already covered by a future scheduled meeting the planner must not
  // duplicate: locked ones (rep/follow-up), whatever their day.
  const coveredVenueIds = new Set<string>();
  for (const m of repMeetings) {
    if (m.status !== "scheduled" || missedSet.has(m.id)) continue;
    if (!m.locked) continue;
    coveredVenueIds.add(m.venueId);
    const key = toDateKey(new Date(m.date));
    const load = dayLoads.get(key);
    if (load) {
      load.count++;
      const venue = venueById.get(m.venueId);
      if (venue?.latitude && venue?.longitude) {
        load.points.push({ lat: venue.latitude, lng: venue.longitude });
      }
    }
  }

  // Stability: where the previous plan put each venue.
  const prevAssignment = new Map<string, string>();
  for (const m of repMeetings) {
    if (m.status === "scheduled" && m.source === "scheduler" && !m.locked && !missedSet.has(m.id)) {
      prevAssignment.set(m.venueId, toDateKey(new Date(m.date)));
    }
  }

  // ---- 4. Who is due inside the horizon --------------------------------------
  // Missed meetings make their venue due immediately, so exclude them from the
  // completed history the engine sees (they never happened).
  const liveMeetings = args.meetings.filter((m) => !missedSet.has(m.id));

  interface Candidate {
    venue: Restaurant;
    dueDate: Date;
    overdueDays: number;
    priorityScore: number;
  }
  const candidates: Candidate[] = [];
  for (const venue of args.venues) {
    if (coveredVenueIds.has(venue.id)) continue;
    if (!venueHasVisitSignal(venue) && !venue.existingCustomer) continue;
    const { schedule, priority } = computeVenueSchedule(venue, liveMeetings, today);
    if (schedule.reminderState === "paused") continue;

    let dueDate: Date | null = schedule.nextSuggestedDate;
    if (!dueDate) {
      // No visit history yet: only plan venues the rep explicitly put on a
      // cadence — "first visit due now".
      if (venue.visitSettings && schedule.effectiveIntervalDays != null) dueDate = today;
      else continue;
    }
    if (dueDate.getTime() > horizonEnd.getTime()) continue; // not due this fortnight

    const overdueDays = Math.max(0, diffInDays(today, dueDate));
    if (dueDate.getTime() < today.getTime()) dueDate = today;
    candidates.push({ venue, dueDate, overdueDays, priorityScore: priority.score });
  }

  // Most urgent first: deepest overdue, then background priority score.
  candidates.sort(
    (a, b) => b.overdueDays - a.overdueDays || b.priorityScore - a.priorityScore || a.venue.name.localeCompare(b.venue.name),
  );

  // ---- 5. Assign each candidate to its cheapest day ---------------------------
  const plan: Meeting[] = [];
  const now = new Date().toISOString();

  for (const c of candidates) {
    const windowStart = addDays(c.dueDate, -FLEX_DAYS_BEFORE);
    const windowEnd = addDays(c.dueDate, FLEX_DAYS_AFTER);
    let window = workingDays.filter((key) => {
      return key >= toDateKey(windowStart >= today ? windowStart : today) && key <= toDateKey(windowEnd);
    });
    // Window swallowed by weekends/horizon edges → first workable day onwards.
    if (window.length === 0) {
      const fromKey = toDateKey(c.dueDate >= today ? c.dueDate : today);
      window = workingDays.filter((key) => key >= fromKey).slice(0, 3);
      if (window.length === 0) window = [workingDays[workingDays.length - 1]];
    }

    const point: LatLng | null =
      c.venue.latitude && c.venue.longitude
        ? { lat: c.venue.latitude, lng: c.venue.longitude }
        : null;
    const prevDay = prevAssignment.get(c.venue.id);

    let bestKey: string | null = null;
    let bestCost = Infinity;
    for (const key of window) {
      const load = dayLoads.get(key);
      if (!load || load.count >= MAX_VISITS_PER_DAY) continue;

      let distance: number;
      if (!point) distance = 0;
      else if (load.points.length === 0) distance = NEW_DAY_COST_METERS;
      else distance = Math.min(...load.points.map((p) => haversineMeters(point, p)));

      const dayDate = new Date(key + "T12:00:00");
      const lateness = Math.max(0, diffInDays(dayDate, c.dueDate)) * LATENESS_COST_METERS_PER_DAY;
      const earliness = Math.max(0, diffInDays(c.dueDate, dayDate)) * 500;
      const stability = prevDay === key ? -1500 : 0;

      const cost = distance + lateness + earliness + stability;
      if (cost < bestCost) {
        bestCost = cost;
        bestKey = key;
      }
    }
    if (!bestKey) continue; // every day in the window is full — next re-flow catches it

    const load = dayLoads.get(bestKey)!;
    load.count++;
    if (point) load.points.push(point);

    const reason =
      c.overdueDays > 0
        ? `Overdue by ${c.overdueDays} day${c.overdueDays === 1 ? "" : "s"}`
        : `Due ${relativeDays(diffInDays(c.dueDate, today))}`;

    plan.push({
      id: schedulerMeetingId(args.rep.id, c.venue.id),
      repId: args.rep.id,
      repName: args.rep.name,
      venueId: c.venue.id,
      venueName: c.venue.name,
      date: dateKeyToIso(bestKey),
      type: "in_person",
      status: "scheduled",
      locked: false,
      source: "scheduler",
      reason,
      createdAt: now,
    });
  }

  return { plan, missedIds };
}

/** Compact signature of a plan (venue→day), used to skip no-op re-flows. */
export function planSignature(meetings: Meeting[]): string {
  return meetings
    .filter((m) => m.status === "scheduled" && m.source === "scheduler" && !m.locked)
    .map((m) => `${m.venueId}:${toDateKey(new Date(m.date))}`)
    .sort()
    .join("|");
}
