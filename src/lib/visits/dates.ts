// Small date helpers for the visit/calendar engines. We work in whole-day
// granularity for scheduling so meetings logged at different times of day
// produce stable intervals. Ported from the Client Meeting Calendar app, with
// extra month-grid helpers so the calendar needs no date library.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight (local) of the given date, as a new Date. */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Whole-day difference a - b (a later than b => positive). */
export function diffInDays(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(a).getTime() - startOfDay(b).getTime()) / MS_PER_DAY,
  );
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function isSameDay(a: Date, b: Date): boolean {
  return diffInDays(a, b) === 0;
}

/** YYYY-MM-DD in local time (good for <input type="date"> and date keys). */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD key (or ISO string) to a local Date at noon — the same
 * convention ContactNote.at uses, so day maths never straddles midnight. */
export function fromDateKey(key: string): Date {
  return new Date(key.slice(0, 10) + "T12:00:00");
}

/** Local-noon ISO string for a YYYY-MM-DD key — the storage format for
 * Meeting.date and ContactNote.at. */
export function dateKeyToIso(key: string): string {
  return fromDateKey(key).toISOString();
}

/** Human-friendly relative phrase, e.g. "in 3 days", "5 days ago", "today". */
export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

// ---- Month-grid helpers (replaces date-fns for the calendar UI) -------------

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1);
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Monday-first day-of-week index (Mon=0 … Sun=6). */
export function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function isWeekend(d: Date): boolean {
  return mondayIndex(d) >= 5;
}

/** All days shown in a Monday-first month grid: from the Monday on/before the
 * 1st to the Sunday on/after the last day. Always whole weeks. */
export function monthGridDays(monthStart: Date): Date[] {
  const first = startOfMonth(monthStart);
  const gridStart = addDays(first, -mondayIndex(first));
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const gridEnd = addDays(lastDay, 6 - mondayIndex(lastDay));
  const days: Date[] = [];
  for (let d = gridStart; d.getTime() <= gridEnd.getTime(); d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtMonthYear(d: Date): string {
  return `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtShortDay(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
