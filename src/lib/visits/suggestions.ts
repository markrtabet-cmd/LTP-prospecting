// ============================================================================
// Suggested visits — the calendar tab's "who should I see in the next few
// weeks" rail.
//
// A Suggestion is NEVER stored: it's recomputed fresh every time from (a)
// each venue's due date (the existing rhythm engine, unchanged) and (b) its
// synced sales-health alerts, so a resync or a threshold tweak is reflected
// immediately with nothing to invalidate. Nothing becomes a real calendar
// entry until the rep explicitly accepts it (see mutations.ts) — the grid
// only ever shows confirmed visits.
//
// The day each suggestion recommends reuses the auto-scheduler's own
// geography-aware placement cost (distance to that day's other confirmed
// stops, plus lateness/earliness against the due date), so a suggestion
// batches efficiently with whatever's already booked — it just stops short
// of writing anything. Unlike the old silent auto-scheduler, there's no
// "stability vs the previous plan" term to worry about: nothing is written,
// so there's nothing to disturb.
//
// This module also computes NeedsLogging: confirmed visits whose date + their
// ±window grace has passed without being logged. Those both (a) surface in
// the overdue panel and (b) flip to status "missed" via the returned
// `missedIds`, mirroring the mutation contract useAutoSchedule already used.
// ============================================================================

import type { Meeting, Rep, Restaurant } from "@/lib/types";
import {
  DEFAULT_INTERVAL_DAYS,
  FLEX_DAYS_AFTER,
  FLEX_DAYS_BEFORE,
  LATENESS_COST_METERS_PER_DAY,
  MAX_VISITS_PER_DAY,
  NEARBY_RADIUS_METERS,
  NEEDS_LOGGING_GRACE_DAYS_MIN,
  NEW_DAY_COST_METERS,
  SUGGESTION_HORIZON_DAYS,
  SUGGESTION_WINDOW_PCT,
} from "./config";
import { addDays, diffInDays, isWeekend, startOfDay, toDateKey } from "./dates";
import { humanIntervalLabel } from "./interval";
import { computeVenueSchedule, venueHasVisitSignal, type VenueSchedule } from "./schedule";
import { detectAllSalesAlerts, type SalesAlert, type SalesAlertType } from "./sales-health";
import { customerActivity, inactivityReason } from "@/lib/customer-activity";

export type SuggestionUrgency = "missed" | "late" | "due" | "soon";

export interface Suggestion {
  venueId: string;
  venueName: string;
  /** The rhythm-engine's due date (ISO), or null for a sales-only flag. */
  dueDate: string | null;
  /** Concrete recommended date (yyyy-MM-dd) — due-aware and batched. */
  suggestedDate: string;
  /** How many CONFIRMED visits are already booked on the suggested date
   * (0 = a fresh day). Other suggestions co-placed that day don't count —
   * they're not bookings. */
  suggestedBatchCount: number;
  /** Distance to the closest CONFIRMED stop on the suggested date, when both
   * ends have coordinates. Drives the "nearby that day" reason. */
  nearestBookedMeters: number | null;
  lastMeetingDate: string | null;
  intervalLabel: string;
  /** The interval actually driving this suggestion (learned / manual / expected). */
  effectiveIntervalDays: number | null;
  /** Negative = past due, null = no rhythm yet. */
  daysUntilDue: number | null;
  daysOverdue: number | null;
  /** ±this many days of the due date still counts as "on time" (not missed). */
  windowRadius: number;
  urgency: SuggestionUrgency;
  /** Power BI sales-health flags (down / stopped / switched), if any. */
  salesAlerts: SalesAlert[];
}

export interface NeedsLoggingItem {
  meetingId: string;
  venueId: string;
  venueName: string;
  /** The visit's booked date (ISO). */
  scheduledDate: string;
  daysOverdue: number;
}

export interface SuggestionsResult {
  suggestions: Suggestion[];
  needsLogging: NeedsLoggingItem[];
  /** Confirmed meetings to flip to status "missed" (caller performs the write). */
  missedIds: string[];
}

export interface BuildSuggestionsArgs {
  rep: Rep;
  /** The venues on this rep's calendar (see venuesForRep). */
  venues: Restaurant[];
  /** ALL meetings — filtered internally. */
  meetings: Meeting[];
  today?: Date;
}

interface LatLng {
  lat: number;
  lng: number;
}

function pointForVenue(venue: Restaurant | undefined): LatLng | null {
  if (!venue) return null;
  if (!Number.isFinite(venue.latitude) || !Number.isFinite(venue.longitude)) return null;
  return { lat: venue.latitude, lng: venue.longitude };
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface VenueInfo extends VenueSchedule {
  venue: Restaurant;
  salesAlerts: SalesAlert[];
  /** ±this many days of the due date still counts as on time. */
  windowRadius: number;
}

function urgencyRank(s: Suggestion): number {
  const hasHigh = s.salesAlerts.some((a) => a.severity === "high");
  const hasAlert = s.salesAlerts.length > 0;
  const bySales = hasHigh ? 0 : hasAlert ? 1 : 3;
  const byTiming = s.urgency === "missed" ? 0 : s.urgency === "late" ? 1 : s.urgency === "due" ? 2 : 3;
  return Math.min(bySales, byTiming);
}

export function buildSuggestions(args: BuildSuggestionsArgs): SuggestionsResult {
  const today = startOfDay(args.today ?? new Date());
  const repMeetings = args.meetings.filter((m) => m.repId === args.rep.id);
  const venueById = new Map(args.venues.map((v) => [v.id, v]));

  // ---- 1. Per-venue schedule + sales alerts, computed once -------------------
  const infoByVenue = new Map<string, VenueInfo>();
  for (const venue of args.venues) {
    const vs = computeVenueSchedule(venue, args.meetings, today);
    let salesAlerts = detectAllSalesAlerts(venue.salesHistory, today);
    // Refine (never widen) the existing "gone quiet" flag for a customer who has
    // now crossed into inactive (3 months, per customer-activity). We only touch
    // venues sales-health ALREADY flagged as stopped_ordering — the same
    // population, so this can't flood the rail with new nags — and we inherit
    // that alert's severity so ranking is unchanged. When a reason is on record
    // (synced from Power BI, or the CLOSED/INACTIVE status), the account is a
    // known quantity: drop the flag so the nudge clears. Otherwise relabel it to
    // say a reason is still needed. A customer only 2 months quiet keeps the
    // plain "gone quiet" flag until they actually go inactive.
    const stopped = venue.existingCustomer ? salesAlerts.find((a) => a.type === "stopped_ordering") : undefined;
    if (stopped && !customerActivity(venue, today).active) {
      const rest = salesAlerts.filter((a) => a.type !== "stopped_ordering");
      salesAlerts = inactivityReason(venue)
        ? rest
        : [inactiveAlert(customerActivity(venue, today).lastOrderMonth, today, stopped.severity), ...rest];
    }
    const interval = vs.schedule.effectiveIntervalDays ?? DEFAULT_INTERVAL_DAYS;
    const windowRadius = Math.max(1, Math.round(interval * SUGGESTION_WINDOW_PCT));
    infoByVenue.set(venue.id, { ...vs, venue, salesAlerts, windowRadius });
  }

  // ---- 2. Needs logging: confirmed visits overdue past their grace window ---
  const needsLogging: NeedsLoggingItem[] = [];
  const missedIds: string[] = [];
  for (const m of repMeetings) {
    if (m.status !== "scheduled" && m.status !== "missed") continue;
    const windowRadius = infoByVenue.get(m.venueId)?.windowRadius ?? DEFAULT_INTERVAL_DAYS * SUGGESTION_WINDOW_PCT;
    const graceDays = Math.max(NEEDS_LOGGING_GRACE_DAYS_MIN, windowRadius);
    const graceDate = addDays(startOfDay(new Date(m.date)), graceDays);
    if (graceDate >= today) continue; // not overdue yet
    if (m.status === "scheduled") missedIds.push(m.id);
    needsLogging.push({
      meetingId: m.id,
      venueId: m.venueId,
      venueName: m.venueName,
      scheduledDate: m.date,
      daysOverdue: diffInDays(today, graceDate),
    });
  }
  needsLogging.sort((a, b) => b.daysOverdue - a.daysOverdue);

  // ---- 3. Working days + day loads from confirmed future visits --------------
  // Every CONFIRMED visit counts as "already out that day" for batching — with
  // suggestions never auto-written, everything in the store is a firm booking.
  const workingDays: string[] = [];
  const horizonSpan = SUGGESTION_HORIZON_DAYS + FLEX_DAYS_AFTER;
  for (let i = 0; i < horizonSpan; i++) {
    const d = addDays(today, i);
    if (!isWeekend(d)) workingDays.push(toDateKey(d));
  }
  // dayLoads drives PLACEMENT (cost model + capacity) and deliberately grows
  // as suggestions are placed, so they cluster with each other too.
  // confirmedByDay is frozen at the real bookings and drives what's REPORTED
  // (batch count, nearby) — a suggestion is only "with other visits" / "nearby"
  // relative to visits that actually exist.
  const dayLoads = new Map<string, { points: LatLng[]; count: number }>();
  const confirmedByDay = new Map<string, { points: LatLng[]; count: number }>();
  for (const key of workingDays) {
    dayLoads.set(key, { points: [], count: 0 });
    confirmedByDay.set(key, { points: [], count: 0 });
  }

  const bookedVenueIds = new Set<string>();
  for (const m of repMeetings) {
    if (m.status !== "scheduled") continue;
    bookedVenueIds.add(m.venueId);
    const key = toDateKey(new Date(m.date));
    const load = dayLoads.get(key);
    if (!load) continue; // outside the working-day horizon
    load.count++;
    const confirmed = confirmedByDay.get(key)!;
    confirmed.count++;
    const p = pointForVenue(venueById.get(m.venueId));
    if (p) {
      load.points.push(p);
      confirmed.points.push(p);
    }
  }
  // A venue with an unresolved overdue booking is already surfaced by the
  // NeedsLogging panel — don't also suggest a fresh visit for it.
  for (const item of needsLogging) bookedVenueIds.add(item.venueId);

  // ---- 4. Gather candidates: due within the horizon, or sales-flagged --------
  interface Candidate {
    venue: Restaurant;
    info: VenueInfo;
    dueDate: Date | null;
    pickerDate: Date;
    overdueDays: number;
    daysUntilDue: number | null;
  }
  const candidates: Candidate[] = [];
  for (const venue of args.venues) {
    if (bookedVenueIds.has(venue.id)) continue;
    if (!venueHasVisitSignal(venue) && !venue.existingCustomer) continue;
    const info = infoByVenue.get(venue.id);
    if (!info || info.schedule.reminderState === "paused") continue;

    // Respect an active push-back / skip.
    const snoozedUntil = venue.visitSettings?.snoozedUntil;
    if (snoozedUntil) {
      const su = startOfDay(new Date(snoozedUntil));
      if (su > today) continue;
    }

    const hasSalesAlert = info.salesAlerts.length > 0;
    // A rep-set cadence counts as a rhythm even before the first logged visit:
    // the rep answered "how often do I see them" during setup, so treat the
    // first visit as due from today rather than never. (reminderState is
    // "no_history" for these venues — without this carve-out the whole
    // setup-completed-but-nothing-logged-yet population could never surface.)
    const repCadence = venue.visitSettings != null && info.schedule.effectiveIntervalDays != null;
    let dueDate: Date | null = info.schedule.nextSuggestedDate;
    if (!dueDate && repCadence) dueDate = today;

    const inclusionLimit = Math.max(info.windowRadius, SUGGESTION_HORIZON_DAYS);
    const timingEligible =
      dueDate != null &&
      (info.schedule.reminderState !== "no_history" || repCadence) &&
      diffInDays(dueDate, today) <= inclusionLimit;

    if (!timingEligible && !hasSalesAlert) continue;

    const pickerDate = timingEligible && dueDate ? dueDate : today;
    const daysUntilDue = timingEligible && dueDate ? diffInDays(dueDate, today) : null;
    const overdueDays = daysUntilDue != null ? Math.max(0, -daysUntilDue) : 0;

    candidates.push({ venue, info, dueDate: timingEligible ? dueDate : null, pickerDate, overdueDays, daysUntilDue });
  }

  // Most urgent first: sales-alert severity, then overdue-ness, then priority.
  candidates.sort((a, b) => {
    const aBucket = a.info.salesAlerts.some((x) => x.severity === "high") ? 0 : a.info.salesAlerts.length ? 1 : 2;
    const bBucket = b.info.salesAlerts.some((x) => x.severity === "high") ? 0 : b.info.salesAlerts.length ? 1 : 2;
    if (aBucket !== bBucket) return aBucket - bBucket;
    if (b.overdueDays !== a.overdueDays) return b.overdueDays - a.overdueDays;
    if (b.info.priority.score !== a.info.priority.score) return b.info.priority.score - a.info.priority.score;
    return a.venue.name.localeCompare(b.venue.name);
  });

  // ---- 5. Place each candidate on its cheapest nearby day --------------------
  const suggestions: Suggestion[] = [];
  for (const c of candidates) {
    const windowStart = addDays(c.pickerDate, -FLEX_DAYS_BEFORE);
    const windowEnd = addDays(c.pickerDate, FLEX_DAYS_AFTER);
    let window = workingDays.filter((key) => {
      const from = windowStart >= today ? windowStart : today;
      return key >= toDateKey(from) && key <= toDateKey(windowEnd);
    });
    if (window.length === 0) {
      const fromKey = toDateKey(c.pickerDate >= today ? c.pickerDate : today);
      window = workingDays.filter((key) => key >= fromKey).slice(0, 3);
      if (window.length === 0 && workingDays.length > 0) window = [workingDays[workingDays.length - 1]];
    }

    const point = pointForVenue(c.venue);

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
      const lateness = Math.max(0, diffInDays(dayDate, c.pickerDate)) * LATENESS_COST_METERS_PER_DAY;
      const earliness = Math.max(0, diffInDays(c.pickerDate, dayDate)) * 500;

      const cost = distance + lateness + earliness;
      if (cost < bestCost) {
        bestCost = cost;
        bestKey = key;
      }
    }
    if (!bestKey) continue; // every candidate day is already full

    const load = dayLoads.get(bestKey)!;
    load.count++;
    if (point) load.points.push(point);

    // Reported batching is against CONFIRMED bookings only.
    const confirmed = confirmedByDay.get(bestKey) ?? { points: [], count: 0 };
    const batchedWith = confirmed.count;
    const nearestBookedMeters =
      point && confirmed.points.length > 0
        ? Math.min(...confirmed.points.map((p) => haversineMeters(point, p)))
        : null;

    const windowRadius = c.info.windowRadius;
    const daysUntilDue = c.daysUntilDue;
    let urgency: SuggestionUrgency;
    if (daysUntilDue == null) urgency = "soon";
    else if (daysUntilDue < -windowRadius) urgency = "missed";
    else if (daysUntilDue < 0) urgency = "late";
    else if (daysUntilDue <= windowRadius) urgency = "due";
    else urgency = "soon";

    suggestions.push({
      venueId: c.venue.id,
      venueName: c.venue.name,
      dueDate: c.dueDate ? c.dueDate.toISOString() : null,
      suggestedDate: bestKey,
      suggestedBatchCount: batchedWith,
      nearestBookedMeters,
      lastMeetingDate: c.info.schedule.lastMeetingDate ? c.info.schedule.lastMeetingDate.toISOString() : null,
      intervalLabel: humanIntervalLabel(c.info.schedule.effectiveIntervalDays),
      effectiveIntervalDays: c.info.schedule.effectiveIntervalDays,
      daysUntilDue,
      daysOverdue: daysUntilDue != null && daysUntilDue < 0 ? -daysUntilDue : null,
      windowRadius,
      urgency,
      salesAlerts: c.info.salesAlerts,
    });
  }

  suggestions.sort((a, b) => {
    const r = urgencyRank(a) - urgencyRank(b);
    if (r !== 0) return r;
    const ad = a.daysUntilDue ?? SUGGESTION_HORIZON_DAYS;
    const bd = b.daysUntilDue ?? SUGGESTION_HORIZON_DAYS;
    if (ad !== bd) return ad - bd;
    return a.venueName.localeCompare(b.venueName);
  });

  return { suggestions, needsLogging, missedIds };
}

// A synthetic sales alert for an inactive customer with no reason on record.
// Not derived from the sales series (sales-health.ts can't see the reason field
// or the 3-month activity rule) — built here where the whole venue is in scope,
// then carried through the same salesAlerts plumbing as the real flags. Severity
// is inherited from the stopped_ordering flag it replaces, so ranking is unchanged.
function inactiveAlert(lastOrderMonth: string | null, today: Date, severity: SalesAlert["severity"]): SalesAlert {
  let headline = "No recent orders";
  if (lastOrderMonth) {
    const [y, m] = lastOrderMonth.split("-").map(Number);
    if (y && m) {
      const months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
      headline = `No orders in ${months} month${months === 1 ? "" : "s"}`;
    }
  }
  return {
    type: "inactive",
    severity,
    title: `${headline} — needs a reason`,
    detail:
      "This customer has gone inactive and no reason is on record. Schedule a meeting to find out why — this clears once the reason is recorded in Power BI.",
    metric: -1,
  };
}

// ---- Reasons (drive the panel's filter chips) -------------------------------

export type SuggestionReason = "overdue" | "due" | SalesAlertType | "nearby";

/** Why a visit is being suggested. The reasons to see a customer are: their
 * visit is due / overdue (rhythm), or Power BI flags their sales (drop /
 * stopped / product switch). "Nearby that day" is an AMPLIFIER, never a reason
 * on its own: an already-justified visit additionally lands within
 * NEARBY_RADIUS_METERS of a confirmed booking that day. A sales-only
 * suggestion (no rhythm — dueDate null) carries no timing reason. Lives here
 * (not in the panel) so the filter chips and any test drive the exact same
 * classification. */
export function suggestionReasons(s: Suggestion): SuggestionReason[] {
  const reasons: SuggestionReason[] = [];
  if (s.dueDate != null) {
    reasons.push(s.urgency === "missed" || s.urgency === "late" ? "overdue" : "due");
  }
  for (const a of s.salesAlerts) reasons.push(a.type);
  if (
    s.suggestedBatchCount > 0 &&
    s.nearestBookedMeters != null &&
    s.nearestBookedMeters <= NEARBY_RADIUS_METERS
  ) {
    reasons.push("nearby");
  }
  return reasons;
}

/** Does a suggestion belong to a specific zoomed-in day? Governed by the
 * ±window around the venue's due date; sales-only flags (no due date) show on
 * the concrete date the tool recommends. */
export function suggestionBelongsToDay(s: Suggestion, day: Date): boolean {
  if (s.dueDate) {
    return Math.abs(diffInDays(day, new Date(s.dueDate))) <= s.windowRadius;
  }
  return s.suggestedDate === toDateKey(day);
}
