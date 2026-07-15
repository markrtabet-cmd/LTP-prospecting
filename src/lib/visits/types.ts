// Enum-like string unions + labels for the visit rhythm/reminder engines.
// Ported from the Client Meeting Calendar app (its Client/Meeting model is
// mapped onto Restaurant + the ltp_meetings table here).

export const INTERVAL_MODES = [
  "automatic",
  "manual",
  "paused",
  "custom_date",
] as const;
export type IntervalMode = (typeof INTERVAL_MODES)[number];

// Three logged interaction types. Visit = the rep went to the venue; Meeting =
// a booked/sit-down appointment; Call = a phone catch-up. Visit and Meeting
// count toward the visit rhythm; a Call is logged but too light-touch to reset
// the cadence clock (see countsTowardRhythm).
export const MEETING_TYPES = [
  "visit",
  "meeting",
  "call",
] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

// Legacy ltp_meetings rows predate the visit/meeting/call split — they stored
// in_person / site_visit / phone / video. Map them on read so old bookings
// still render and still count (or not) correctly, with no DB migration.
const LEGACY_MEETING_TYPES: Record<string, MeetingType> = {
  in_person: "visit",
  site_visit: "visit",
  phone: "call",
  video: "call",
};

/** Coerce any stored/legacy meeting-type string to one of the three current
 * types. Unknown values fall back to "visit" (in-person, counts). */
export function normalizeMeetingType(raw: string | null | undefined): MeetingType {
  if (!raw) return "visit";
  if ((MEETING_TYPES as readonly string[]).includes(raw)) return raw as MeetingType;
  return LEGACY_MEETING_TYPES[raw] ?? "visit";
}

/** Whether a meeting type counts toward a venue's visit rhythm. Visits and
 * meetings do; a call is logged but does not reset the cadence. */
export function countsTowardRhythm(type: string | null | undefined): boolean {
  return normalizeMeetingType(type) !== "call";
}

// "missed" is new here: a confirmed visit whose date + grace window passed
// without being recorded — it surfaces daily in the overdue panel until the
// rep logs it, reschedules it, or skips it (see src/lib/visits/suggestions.ts).
export const MEETING_STATUSES = ["scheduled", "completed", "missed", "cancelled"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// Who created a meeting: the rep by hand — either booked directly or by
// accepting a suggestion — or an AI-detected follow-up commitment from a
// meeting summary. Both are confirmed, locked bookings; suggestions never
// become a Meeting until one of these creates it.
export const MEETING_SOURCES = ["rep", "followup"] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export const PRIORITY_LEVELS = ["high", "medium", "low", "none"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const REMINDER_STATES = [
  "no_history",
  "recent",
  "upcoming",
  "due_today",
  "overdue",
  "paused",
] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

// ---- Display labels ---------------------------------------------------------

export const VISIT_LABELS = {
  intervalMode: {
    automatic: "Automatic (learns from history)",
    manual: "Fixed interval",
    paused: "Paused (no reminders)",
    custom_date: "Custom next date",
  } as Record<IntervalMode, string>,
  meetingType: {
    visit: "Visit",
    meeting: "Meeting",
    call: "Call",
  } as Record<MeetingType, string>,
  meetingStatus: {
    scheduled: "Scheduled",
    completed: "Completed",
    missed: "Missed",
    cancelled: "Cancelled",
  } as Record<MeetingStatus, string>,
  reminderState: {
    no_history: "No history",
    recent: "On track",
    upcoming: "Due soon",
    due_today: "Due today",
    overdue: "Overdue",
    paused: "Paused",
  } as Record<ReminderState, string>,
} as const;

// Reminder state → badge classes, matching the host app's badge idiom.
export const REMINDER_STATE_STYLE: Record<ReminderState, string> = {
  no_history: "bg-slate-100 text-slate-600",
  recent: "bg-green-100 text-green-700",
  upcoming: "bg-amber-100 text-amber-700",
  due_today: "bg-amber-100 text-amber-800",
  overdue: "bg-red-100 text-red-700",
  paused: "bg-slate-100 text-slate-500",
};
