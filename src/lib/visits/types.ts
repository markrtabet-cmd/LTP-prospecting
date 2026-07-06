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

export const MEETING_TYPES = [
  "in_person",
  "phone",
  "video",
  "site_visit",
] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

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
    in_person: "In person",
    phone: "Phone",
    video: "Video",
    site_visit: "Site visit",
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
