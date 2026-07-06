// Turns a Suggestion into a real, confirmed Meeting, and builds the
// visitSettings patch for pushing back / skipping a suggestion. Both are
// plain builders — same shape as buildScheduledMeeting in meetings-store.tsx —
// so callers just feed the result into the existing addMeeting/updateRestaurant
// store calls. No new API routes: accepting rides the same /api/meetings path
// every other booked visit already uses.

import type { Meeting, VisitSettings } from "@/lib/types";
import { fromDateKey } from "./dates";
import type { Suggestion } from "./suggestions";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Accept a suggestion — optionally onto a different day than recommended.
 * Accepted visits are LOCKED, same as any rep-booked meeting: the suggestions
 * engine treats every confirmed visit as a fixed anchor, never something to
 * silently move once it exists.
 */
export function buildAcceptedMeeting(args: {
  repId: string;
  repName: string;
  suggestion: Suggestion;
  /** Override the recommended date, e.g. "accept but put it on another day". */
  dateKey?: string;
}): Meeting {
  const dateKey = args.dateKey ?? args.suggestion.suggestedDate;
  return {
    id: newId("mtg"),
    repId: args.repId,
    repName: args.repName,
    venueId: args.suggestion.venueId,
    venueName: args.suggestion.venueName,
    date: fromDateKey(dateKey).toISOString(),
    type: "in_person",
    status: "scheduled",
    locked: true,
    source: "rep",
    createdAt: new Date().toISOString(),
  };
}

export type SnoozeAction = "push" | "skip" | "clear";

/**
 * Push a suggestion back N days, skip it for a full cycle, or clear an
 * existing snooze. Returns the visitSettings fields to merge in via
 * updateRestaurant(venue.id, { visitSettings: { ...current, ...patch } }).
 */
export function buildSnoozePatch(args: {
  action: SnoozeAction;
  /** Days to push back — only used for "push". */
  days?: number;
  /** The venue's effective interval — only used for "skip". */
  intervalDays?: number | null;
  reason?: string;
  today?: Date;
}): Pick<VisitSettings, "snoozedUntil" | "snoozeReason"> {
  if (args.action === "clear") return { snoozedUntil: null, snoozeReason: null };

  const base = new Date(args.today ?? new Date());
  base.setHours(12, 0, 0, 0);
  if (args.action === "push") {
    base.setDate(base.getDate() + (args.days ?? 7));
  } else {
    // Skip this cycle: suggest again about one interval from now — works even
    // when the visit is already well overdue.
    base.setDate(base.getDate() + (args.intervalDays ?? 30));
  }
  return { snoozedUntil: base.toISOString(), snoozeReason: args.reason ?? null };
}
