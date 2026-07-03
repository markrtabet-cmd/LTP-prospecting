// ============================================================================
// Scheduling & reminder-state logic (PRD §6.5, §6.6, §6.9).
//
// Turns a client's interval mode + meeting history + learned estimate into:
//   - the effective interval actually used,
//   - the suggested next meeting date,
//   - a computed reminder state (overdue / due today / due soon / on track …).
//
// Pure functions only — no DB access — so they are easy to test.
// ============================================================================

import { addDays, diffInDays, startOfDay } from "./dates";
import type { IntervalEstimate } from "./interval";
import type { IntervalMode, ReminderState } from "./types";

export interface ScheduleInput {
  intervalMode: IntervalMode;
  manualIntervalDays: number | null;
  customNextDate: Date | null;
  /**
   * The rep's first-visit setup answer ("I normally visit them every N days").
   * Used as the starting rhythm before enough real history exists, gradually
   * handing over to the learned estimate as gaps accumulate.
   */
  expectedIntervalDays?: number | null;
  /** Client relationship status; "paused" suppresses reminders too. */
  clientPaused: boolean;
  /** Completed meeting dates (any order). */
  completedMeetingDates: Date[];
  estimate: IntervalEstimate;
  defaultIntervalDays: number;
  dueSoonLeadDays: number;
  /** "Now" — injectable for testing. Defaults to current date. */
  today?: Date;
}

export type IntervalSource =
  | "manual"
  | "automatic"
  | "expected" // rep's setup answer (possibly blended with early history)
  | "custom_date"
  | "default"
  | "paused"
  | "none";

export interface ScheduleInfo {
  effectiveIntervalDays: number | null;
  intervalSource: IntervalSource;
  lastMeetingDate: Date | null;
  nextSuggestedDate: Date | null;
  reminderState: ReminderState;
  /** Days until the suggested date (negative when overdue), null if N/A. */
  daysUntilDue: number | null;
  daysOverdue: number | null;
}

function latest(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

export function computeSchedule(input: ScheduleInput): ScheduleInfo {
  const today = startOfDay(input.today ?? new Date());
  const lastMeetingDate = latest(input.completedMeetingDates);

  const paused = input.clientPaused || input.intervalMode === "paused";

  // ---- Paused: no reminders at all -----------------------------------------
  if (paused) {
    return {
      effectiveIntervalDays: null,
      intervalSource: "paused",
      lastMeetingDate,
      nextSuggestedDate: null,
      reminderState: "paused",
      daysUntilDue: null,
      daysOverdue: null,
    };
  }

  // ---- Custom fixed next date ----------------------------------------------
  if (input.intervalMode === "custom_date" && input.customNextDate) {
    const next = startOfDay(input.customNextDate);
    return finalize({
      effectiveIntervalDays: null,
      intervalSource: "custom_date",
      lastMeetingDate,
      nextSuggestedDate: next,
      today,
      dueSoonLeadDays: input.dueSoonLeadDays,
    });
  }

  // ---- Determine the effective interval ------------------------------------
  let effectiveIntervalDays: number | null = null;
  let intervalSource: IntervalSource = "none";

  const expected = input.expectedIntervalDays ?? null;
  const learned = input.estimate.estimatedDays;
  const observedGaps = input.estimate.observedIntervals.length;

  if (input.intervalMode === "manual" && input.manualIntervalDays) {
    effectiveIntervalDays = input.manualIntervalDays;
    intervalSource = "manual";
  } else if (learned != null && (expected == null || observedGaps >= 3)) {
    // Enough real history (or no setup answer to lean on) → fully learned.
    effectiveIntervalDays = learned;
    intervalSource = "automatic";
  } else if (expected != null && learned != null) {
    // Early days: blend the rep's setup answer with what little history there
    // is. Each observed gap shifts a third of the weight from answer → history,
    // so by 3 gaps the learned rhythm has fully taken over.
    const learnedWeight = Math.min(observedGaps, 3) / 3;
    effectiveIntervalDays = Math.round(
      expected * (1 - learnedWeight) + learned * learnedWeight,
    );
    intervalSource = "expected";
  } else if (expected != null) {
    effectiveIntervalDays = expected;
    intervalSource = "expected";
  } else {
    // Not enough history yet → fall back to the configured default (PRD §7.1).
    effectiveIntervalDays = input.defaultIntervalDays;
    intervalSource = "default";
  }

  // ---- No meetings yet → nothing to schedule from --------------------------
  if (!lastMeetingDate) {
    return {
      effectiveIntervalDays,
      intervalSource,
      lastMeetingDate: null,
      nextSuggestedDate: null,
      reminderState: "no_history",
      daysUntilDue: null,
      daysOverdue: null,
    };
  }

  const nextSuggestedDate = addDays(startOfDay(lastMeetingDate), effectiveIntervalDays);

  return finalize({
    effectiveIntervalDays,
    intervalSource,
    lastMeetingDate,
    nextSuggestedDate,
    today,
    dueSoonLeadDays: input.dueSoonLeadDays,
  });
}

function finalize(args: {
  effectiveIntervalDays: number | null;
  intervalSource: IntervalSource;
  lastMeetingDate: Date | null;
  nextSuggestedDate: Date;
  today: Date;
  dueSoonLeadDays: number;
}): ScheduleInfo {
  const daysUntilDue = diffInDays(args.nextSuggestedDate, args.today);
  let reminderState: ReminderState;
  if (daysUntilDue < 0) reminderState = "overdue";
  else if (daysUntilDue === 0) reminderState = "due_today";
  else if (daysUntilDue <= args.dueSoonLeadDays) reminderState = "upcoming";
  else reminderState = "recent";

  return {
    effectiveIntervalDays: args.effectiveIntervalDays,
    intervalSource: args.intervalSource,
    lastMeetingDate: args.lastMeetingDate,
    nextSuggestedDate: args.nextSuggestedDate,
    reminderState,
    daysUntilDue,
    daysOverdue: daysUntilDue < 0 ? -daysUntilDue : null,
  };
}

/** Short, human reminder sentence for dashboards/notifications (PRD §6.6). */
export function reminderMessage(
  clientName: string,
  schedule: ScheduleInfo,
  intervalLabel: string,
): string | null {
  switch (schedule.reminderState) {
    case "overdue":
      return `${clientName} is overdue by ${schedule.daysOverdue} day${
        schedule.daysOverdue === 1 ? "" : "s"
      }. Usual rhythm: ${intervalLabel}.`;
    case "due_today":
      return `${clientName} is due for a meeting today.`;
    case "upcoming":
      return `${clientName} is due in ${schedule.daysUntilDue} day${
        schedule.daysUntilDue === 1 ? "" : "s"
      }.`;
    default:
      return null;
  }
}
