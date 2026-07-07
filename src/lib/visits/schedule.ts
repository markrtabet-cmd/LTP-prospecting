// Adapter between the host data model (Restaurant + contactLog + ltp_meetings)
// and the pure visit engines. Phase-1 trick: completed visits are read from the
// EXISTING contact log (outcomes "meeting"/"visited") plus completed calendar
// meetings, so rhythm/reminders work with no new data entry.

import type { Meeting, Rep, Restaurant } from "@/lib/types";
import {
  DEFAULT_INTERVAL_DAYS,
  DUE_SOON_LEAD_DAYS,
  INTERVAL_WINDOW,
  PRIORITY_VALUE_REFERENCE,
} from "./config";
import { estimateInterval, type IntervalEstimate } from "./interval";
import { computeSchedule, type ScheduleInfo } from "./reminders";
import { computePriority, type PriorityResult } from "./priority";
import { normalizeName } from "./match";

/** Completed visit dates for a venue: qualifying contact-log notes ∪ completed
 * calendar meetings. Same-day duplicates are harmless — the interval engine
 * drops 0-day gaps. */
export function visitDatesForVenue(r: Restaurant, meetings: Meeting[] = []): Date[] {
  const dates: Date[] = [];
  for (const n of r.contactLog ?? []) {
    if (n.outcome === "meeting" || n.outcome === "visited") {
      const d = new Date(n.at);
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }
  for (const m of meetings) {
    if (m.venueId === r.id && m.status === "completed") {
      const d = new Date(m.date);
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }
  return dates;
}

export interface VenueSchedule {
  estimate: IntervalEstimate;
  schedule: ScheduleInfo;
  priority: PriorityResult;
}

export function computeVenueSchedule(
  r: Restaurant,
  meetings: Meeting[] = [],
  today: Date = new Date(),
): VenueSchedule {
  const vs = r.visitSettings;
  const completedMeetingDates = visitDatesForVenue(r, meetings);
  const estimate = estimateInterval(completedMeetingDates, { windowSize: INTERVAL_WINDOW });
  const schedule = computeSchedule({
    intervalMode: vs?.intervalMode ?? "automatic",
    manualIntervalDays: vs?.manualIntervalDays ?? null,
    customNextDate: vs?.customNextDate ? new Date(vs.customNextDate) : null,
    expectedIntervalDays: vs?.expectedIntervalDays ?? null,
    clientPaused: false,
    completedMeetingDates,
    estimate,
    defaultIntervalDays: DEFAULT_INTERVAL_DAYS,
    dueSoonLeadDays: DUE_SOON_LEAD_DAYS,
    today,
  });
  // Priority runs in the background only (feeds the scheduler's ordering) —
  // annual value isn't wired yet, so timing + frequency carry the score.
  const priority = computePriority(
    {
      reminderState: schedule.reminderState,
      effectiveIntervalDays: schedule.effectiveIntervalDays,
      daysUntilDue: schedule.daysUntilDue,
      annualValue: null,
    },
    { valueReference: PRIORITY_VALUE_REFERENCE },
  );
  return { estimate, schedule, priority };
}

/** A venue takes part in the visit calendar when it's a customer with a rep
 * cadence set, or it has any qualifying visit history. Keeps the engines off
 * the ~20k-venue base dataset. */
export function venueHasVisitSignal(r: Restaurant): boolean {
  if (r.visitSettings) return true;
  return (r.contactLog ?? []).some(
    (n) => n.outcome === "meeting" || n.outcome === "visited",
  );
}

// ---- Rep ↔ venue assignment -------------------------------------------------

/** Which rep's calendar a venue belongs to. Manual assignment wins; otherwise
 * the Power BI account manager name is matched against rep names/aliases. */
export function repForVenue(r: Restaurant, reps: Rep[]): Rep | null {
  if (r.assignedRepId) {
    const rep = reps.find((x) => x.id === r.assignedRepId);
    if (rep) return rep;
  }
  const manager = r.customerAccountManager;
  if (!manager) return null;
  const norm = normalizeName(manager);
  if (!norm) return null;
  for (const rep of reps) {
    const candidates = [rep.name, ...(rep.aliases ?? [])];
    for (const c of candidates) {
      const cn = normalizeName(c);
      if (!cn) continue;
      if (cn === norm || norm.includes(cn) || cn.includes(norm)) return rep;
    }
  }
  return null;
}

/** All venues on a rep's calendar: manually assigned to them, auto-matched via
 * the account-manager name — or UNATTRIBUTABLE (no manual assignment and no
 * roster match, e.g. while the ltp_users roster is empty or a Power BI manager
 * name matches nobody). Unattributable venues appear on EVERY rep's calendar
 * rather than vanishing from all of them: with an empty roster that makes the
 * whole customer base shared (so suggestions/KPIs still work), and once the
 * roster is populated each venue leaves the shared pool as soon as it matches
 * a rep. */
export function venuesForRep(restaurants: Restaurant[], rep: Rep, reps: Rep[]): Restaurant[] {
  return restaurants.filter((r) => {
    if (r.assignedRepId) return r.assignedRepId === rep.id;
    if (!r.existingCustomer && !r.visitSettings) return false;
    const matched = repForVenue(r, reps);
    return matched === null || matched.id === rep.id;
  });
}
