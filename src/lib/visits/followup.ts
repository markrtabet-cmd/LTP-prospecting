// Turn an AI-detected follow-up commitment ("they asked me to come back in two
// weeks") into a concrete working-day date the scheduler must plan around.

import { addDays, isWeekend, startOfDay, toDateKey } from "./dates";

export interface FollowUpDetection {
  /** Relative commitment in days from the meeting date. */
  days?: number | null;
  /** Absolute date (YYYY-MM-DD or ISO), when the rep named one. */
  date?: string | null;
  /** The phrase that triggered the detection, for the calendar entry. */
  quote?: string | null;
}

/** Resolve a detection to a YYYY-MM-DD key on a working day (Sat/Sun roll to
 * Monday), or null when there's nothing usable. */
export function followUpDateKey(
  detection: FollowUpDetection | null | undefined,
  meetingDate: Date,
): string | null {
  if (!detection) return null;
  let target: Date | null = null;
  if (detection.date) {
    const d = new Date(detection.date.slice(0, 10) + "T12:00:00");
    if (!isNaN(d.getTime())) target = d;
  }
  if (!target && detection.days != null && detection.days > 0 && detection.days < 400) {
    target = addDays(startOfDay(meetingDate), Math.round(detection.days));
  }
  if (!target) return null;
  // Never chain a follow-up into the past.
  const tomorrow = addDays(startOfDay(new Date()), 1);
  if (target.getTime() < tomorrow.getTime()) target = tomorrow;
  while (isWeekend(target)) target = addDays(target, 1);
  return toDateKey(target);
}
