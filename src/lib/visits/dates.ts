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

/** Timestamp for a note/log keyed by a YYYY-MM-DD day, recording WHEN it was
 * written rather than a fixed noon: today's key → "now"; a back-dated key keeps
 * that day but stamps the current clock time. Day maths elsewhere floors to the
 * day (startOfDay/diffInDays), so the real time never straddles into another. */
export function dateKeyToLoggedIso(key: string, now: Date = new Date()): string {
  if (key.slice(0, 10) === toDateKey(now)) return now.toISOString();
  const d = fromDateKey(key);
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return d.toISOString();
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

// ---- Time-of-day helpers (calendar timings) --------------------------------

/** The rep working window and default visit length used by time suggestion. */
export const DAY_START_MIN = 9 * 60; // 09:00
export const DAY_END_MIN = 18 * 60; // 18:00
export const DEFAULT_VISIT_MINUTES = 45;
// Fallback slot when there's nothing to anchor a smart time to (an empty day):
// a visit still gets a concrete time so time is part of every booking.
export const DEFAULT_VISIT_TIME = "10:00";

/** "HH:mm" → minutes past midnight, or null if malformed. */
export function hhmmToMinutes(hhmm: string | undefined | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes past midnight → "HH:mm" (24h, zero-padded). */
export function minutesToHHMM(mins: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Human display for a time, e.g. "9:00 am". Falls back to "" for no time. */
export function fmtTime(hhmm: string | undefined | null): string {
  const mins = hhmmToMinutes(hhmm);
  if (mins == null) return "";
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** A booked visit reduced to what time suggestion needs: its slot + location. */
export interface TimedPoint {
  startTime?: string | null;
  lat?: number | null;
  lng?: number | null;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Suggest a smart start time for a new visit on a day — or `undefined` when
 * there's nothing to base one on (an empty day, or one with no *timed* visits;
 * the rep can still set a time by hand). When the day already has timed visits,
 * cluster the new one right after whichever booked visit is geographically
 * CLOSEST (so consecutive stops sit near each other — good for the drive),
 * skipping any overlap and staying inside the 9-18h working window. Falls back
 * to "after the last visit of the day" when coordinates aren't available.
 */
export function suggestVisitTime(
  dayMeetings: TimedPoint[],
  newVenue?: { lat?: number | null; lng?: number | null } | null,
  durationMinutes: number = DEFAULT_VISIT_MINUTES,
): string | undefined {
  const timed: { mins: number; lat?: number | null; lng?: number | null }[] = [];
  for (const m of dayMeetings) {
    const mins = hhmmToMinutes(m.startTime ?? undefined);
    if (mins == null) continue;
    timed.push({ mins, lat: m.lat, lng: m.lng });
  }
  timed.sort((a, b) => a.mins - b.mins);
  if (timed.length === 0) return undefined; // nothing to anchor to

  // Anchor to the geographically nearest booked visit when both ends have
  // coordinates; otherwise anchor to the last visit of the day.
  let anchor = timed[timed.length - 1];
  const nv = newVenue && newVenue.lat != null && newVenue.lng != null ? { lat: newVenue.lat, lng: newVenue.lng } : null;
  if (nv) {
    let best = Infinity;
    for (const t of timed) {
      if (t.lat == null || t.lng == null) continue;
      const d = haversineKm(nv, { lat: t.lat, lng: t.lng });
      if (d < best) {
        best = d;
        anchor = t;
      }
    }
  }

  // Start just after the anchor, then bump past anything we'd overlap.
  const taken = timed.map((t) => t.mins);
  let slot = anchor.mins + durationMinutes;
  for (let guard = 0; guard <= taken.length; guard++) {
    const clash = taken.find((t) => slot < t + durationMinutes && slot + durationMinutes > t);
    if (clash == null) break;
    slot = clash + durationMinutes;
  }
  if (slot > DAY_END_MIN - durationMinutes) return undefined; // no room left that day
  return minutesToHHMM(Math.max(DAY_START_MIN, slot));
}
