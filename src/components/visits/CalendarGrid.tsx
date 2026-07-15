"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, Lock, MapPin, Mic, Sparkles } from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
import {
  addDays,
  addMonths,
  fmtMonthYear,
  fmtShortDay,
  fmtTime,
  hhmmToMinutes,
  isSameDay,
  isSameMonth,
  monthGridDays,
  startOfMonth,
  toDateKey,
} from "@/lib/visits/dates";
import { VISIT_LABELS, normalizeMeetingType } from "@/lib/visits/types";
import type { Meeting, Restaurant } from "@/lib/types";
import { buildGoogleMapsDirUrl, optimizeRoute, type RoutePoint } from "@/lib/route-planning";
import { ScheduleVisitModal } from "./ScheduleVisitModal";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type CalendarGridView = "month" | "day";

function chipClasses(m: Meeting): string {
  if (m.status === "completed") return "bg-green-100 text-green-800";
  if (m.status === "missed") return "bg-red-100 text-red-700";
  return "bg-indigo-100 text-indigo-800"; // booked — either directly or by accepting a suggestion
}

// The month grid ↔ single-day zoom for a rep's REAL visits (booked + past —
// never suggestions, those live in SuggestionsPanel). Self-contained: reads
// meetings/venues/rep from the shared stores directly, same as the rest of
// the app's screen-level components.
export function CalendarGrid({
  onRecord,
  onOpenVenue,
  onViewChange,
  compact = false,
  showRouteButton = false,
  subjectRepId,
  readOnly = false,
}: {
  /** Open the record-meeting flow for a venue (optionally completing a
   * specific scheduled meeting). Hidden when not provided. */
  onRecord?: (venue: Restaurant, meeting?: Meeting) => void;
  /** Mobile: jump to the venue pin instead of navigating to the profile. */
  onOpenVenue?: (venueId: string) => void;
  /** Fires whenever the zoomed day or view mode changes, so a parent can
   * scope its own suggestions list to match (e.g. "suggested for this day"). */
  onViewChange?: (view: CalendarGridView, dateKey: string) => void;
  compact?: boolean;
  /** Mobile only: show a "Route" button in day view that auto-builds a
   * driving route between that day's scheduled visits. */
  showRouteButton?: boolean;
  /** Whose calendar to show. Defaults to the signed-in user; an admin viewing a
   * rep passes that rep's id. */
  subjectRepId?: string;
  /** Read-only view (an admin looking at a rep's calendar): no booking, moving
   * or scheduling. */
  readOnly?: boolean;
}) {
  const { meetings, updateMeeting } = useMeetings();
  const { me } = useRep();
  const { restaurants, updateRestaurant } = useRestaurants();
  const calendarRepId = subjectRepId ?? me?.id;

  const [view, setView] = useState<CalendarGridView>("month");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [selectedKey, setSelectedKey] = useState<string>(() => toDateKey(new Date()));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState("");
  const [moveTime, setMoveTime] = useState("");
  const [routing, setRouting] = useState(false);

  const today = new Date();
  const days = useMemo(() => monthGridDays(cursor), [cursor]);

  const mine = useMemo(
    () => meetings.filter((m) => m.repId === calendarRepId && m.status !== "cancelled"),
    [meetings, calendarRepId],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Meeting[]>();
    for (const m of mine) {
      const key = toDateKey(new Date(m.date));
      const arr = map.get(key) ?? [];
      arr.push(m);
      map.set(key, arr);
    }
    map.forEach((arr) => {
      arr.sort((a, b) => Number(b.locked) - Number(a.locked) || a.venueName.localeCompare(b.venueName));
    });
    return map;
  }, [mine]);

  // The zoomed day's visits, ordered as a timed list: timed slots first in
  // chronological order, any day-only visits after them.
  const selectedMeetings = useMemo(() => {
    const arr = [...(byDay.get(selectedKey) ?? [])];
    return arr.sort((a, b) => {
      const ta = hhmmToMinutes(a.startTime);
      const tb = hhmmToMinutes(b.startTime);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });
  }, [byDay, selectedKey]);
  const venueById = useMemo(() => new Map(restaurants.map((r) => [r.id, r])), [restaurants]);

  // Leads a rep pinned "go visit on this day" from the leads table — shown
  // BELOW the booked visits, not mixed into the timed slots.
  const flaggedForDay = useMemo(
    () => restaurants.filter((r) => r.flaggedVisitDate === selectedKey),
    [restaurants, selectedKey],
  );

  // Stops for the day's auto-route: venues with a CONFIRMED visit today (not
  // completed/missed/cancelled — those aren't "on today's run" any more) that
  // have resolvable coordinates.
  const routeStops = useMemo<RoutePoint[]>(() => {
    return selectedMeetings
      .filter((m) => m.status === "scheduled")
      .map((m) => venueById.get(m.venueId))
      .filter((v): v is Restaurant => !!v && !!v.latitude && !!v.longitude)
      .map((v) => ({ id: v.id, name: v.name, lat: v.latitude, lng: v.longitude }));
  }, [selectedMeetings, venueById]);

  function getCurrentLocation(timeoutMs: number): Promise<RoutePoint | null> {
    return new Promise((resolve) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => resolve(null), timeoutMs);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          resolve({ id: "me", name: "My location", lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
        { maximumAge: 60_000, timeout: timeoutMs },
      );
    });
  }

  // Auto-route today's confirmed visits — no manual stop-picking, unlike the
  // map's route planner. Falls back to starting from the first stop when
  // location isn't available (same graceful fallback the map planner uses).
  async function startRoute() {
    if (routeStops.length < 2 || routing) return;
    setRouting(true);
    try {
      const here = await getCurrentLocation(3000);
      const start = here ?? routeStops[0];
      const rest = here ? routeStops : routeStops.slice(1);
      const path = optimizeRoute(start, rest);
      window.open(buildGoogleMapsDirUrl(path), "_blank", "noopener,noreferrer");
    } finally {
      setRouting(false);
    }
  }

  function notify(nextView: CalendarGridView, dateKey: string) {
    onViewChange?.(nextView, dateKey);
  }

  function zoomToDay(day: Date) {
    const key = toDateKey(day);
    setSelectedKey(key);
    setCursor(startOfMonth(day));
    setView("day");
    notify("day", key);
  }

  function showMonth() {
    setView("month");
    notify("month", selectedKey);
  }

  function step(dir: 1 | -1) {
    if (view === "day") {
      const next = addDays(new Date(selectedKey + "T12:00:00"), dir);
      zoomToDay(next);
    } else {
      setCursor((c) => addMonths(c, dir));
    }
  }

  function goToday() {
    if (view === "day") zoomToDay(today);
    else {
      setCursor(startOfMonth(today));
      setSelectedKey(toDateKey(today));
    }
  }

  function openMove(m: Meeting) {
    setMoveDate(toDateKey(new Date(m.date)));
    setMoveTime(m.startTime ?? "");
    setMoveId(m.id);
  }

  function saveMove(m: Meeting, dateKey: string, time: string) {
    updateMeeting(m.id, {
      date: new Date(dateKey + "T12:00:00").toISOString(),
      startTime: time || undefined,
      status: "scheduled",
      reason: undefined,
    });
    setMoveId(null);
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className={`font-semibold text-slate-900 ${compact ? "text-sm" : "text-lg"}`}>
          {view === "day" ? fmtShortDay(new Date(selectedKey + "T12:00:00")) : fmtMonthYear(cursor)}
        </h2>
        <div className="flex items-center gap-1">
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => step(-1)}
            aria-label={view === "day" ? "Previous day" : "Previous month"}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            onClick={goToday}
          >
            Today
          </button>
          {/* Month / Day view toggle — always visible, same as the "Day"
              zoom you get from tapping a date, just explicit either way. */}
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
            <button
              onClick={showMonth}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === "month" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              Month
            </button>
            <button
              onClick={() => zoomToDay(new Date(selectedKey + "T12:00:00"))}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === "day" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              Day
            </button>
          </div>
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => step(1)}
            aria-label={view === "day" ? "Next day" : "Next month"}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {view === "month" ? (
        <>
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-500">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const key = toDateKey(day);
              const dayMeetings = byDay.get(key) ?? [];
              const inMonth = isSameMonth(day, cursor);
              const maxChips = compact ? 2 : 3;
              return (
                <button
                  key={key}
                  onClick={() => zoomToDay(day)}
                  className={`${compact ? "min-h-[64px]" : "min-h-[92px]"} border-b border-r border-slate-100 p-1 text-left align-top ${
                    inMonth ? "bg-white hover:bg-brand-50/40" : "bg-slate-50/60"
                  }`}
                  title="Click to zoom into this day"
                >
                  <div
                    className={`mb-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                      isSameDay(day, today)
                        ? "bg-brand-500 font-semibold text-white"
                        : inMonth
                          ? "text-slate-700"
                          : "text-slate-400"
                    }`}
                  >
                    {day.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {dayMeetings.slice(0, maxChips).map((m) => (
                      <div
                        key={m.id}
                        className={`flex items-center gap-0.5 truncate rounded px-1 py-0.5 text-[10px] font-medium ${chipClasses(m)}`}
                        title={`${m.venueName} — ${VISIT_LABELS.meetingStatus[m.status]}`}
                      >
                        {m.locked && m.status === "scheduled" && <Lock className="h-2.5 w-2.5 shrink-0" />}
                        {m.source === "followup" && <Sparkles className="h-2.5 w-2.5 shrink-0" />}
                        <span className="truncate">{m.venueName}</span>
                      </div>
                    ))}
                    {dayMeetings.length > maxChips && (
                      <div className="px-1 text-[9px] text-slate-400">+{dayMeetings.length - maxChips} more</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2 text-[11px] text-slate-500">
            <Legend className="bg-indigo-400" label="Booked" />
            <Legend className="bg-green-400" label="Done" />
            <Legend className="bg-red-400" label="Missed" />
          </div>
        </>
      ) : null}

      {/* Day detail — always the zoomed-in day's content; the whole grid card
          becomes this when a day is selected. */}
      {view === "day" && (
        <div className="px-4 py-3">
          {/* Big date badge + day name, same idea as the reference calendar. */}
          <div className="mb-3 flex items-center gap-3">
            <span
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-bold ${
                isSameDay(new Date(selectedKey + "T12:00:00"), today)
                  ? "bg-brand-500 text-white"
                  : "bg-brand-50 text-brand-700"
              }`}
            >
              {new Date(selectedKey + "T12:00:00").getDate()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                {isSameDay(new Date(selectedKey + "T12:00:00"), today)
                  ? "Today"
                  : new Date(selectedKey + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" })}
              </p>
              <p className="text-xs text-slate-500">{fmtMonthYear(new Date(selectedKey + "T12:00:00"))}</p>
            </div>
            <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {selectedMeetings.length} visit{selectedMeetings.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {!readOnly && (
              <button
                onClick={() => setScheduleOpen(true)}
                className="flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white active:scale-95"
              >
                <CalendarPlus className="h-3.5 w-3.5" /> Book visit
              </button>
            )}
            {showRouteButton && routeStops.length >= 2 && (
              <button
                onClick={startRoute}
                disabled={routing}
                className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 active:scale-95 disabled:opacity-60"
                title="Open an optimised driving route through today's visits"
              >
                {routing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="19" r="2" />
                    <circle cx="18" cy="5" r="2" />
                    <path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h4" />
                  </svg>
                )}
                Route
              </button>
            )}
          </div>

          {selectedMeetings.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
              Nothing booked — check the suggestions below.
            </p>
          ) : (
            <ul className="space-y-2">
              {selectedMeetings.map((m) => {
                const venue = venueById.get(m.venueId);
                return (
                  <li key={m.id} className="rounded-xl bg-slate-50 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="shrink-0 whitespace-nowrap rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
                          {m.startTime ? fmtTime(m.startTime) : "Any time"}
                        </span>
                        <div className="min-w-0">
                        {onOpenVenue ? (
                          <button
                            onClick={() => onOpenVenue(m.venueId)}
                            className="block max-w-full truncate text-sm font-semibold text-slate-800 underline-offset-2 active:underline"
                          >
                            {m.venueName}
                          </button>
                        ) : (
                          <Link
                            href={`/restaurants/${m.venueId}`}
                            className="block max-w-full truncate text-sm font-semibold text-slate-800 hover:underline"
                          >
                            {m.venueName}
                          </Link>
                        )}
                        <p className="text-xs text-slate-500">
                          {VISIT_LABELS.meetingType[normalizeMeetingType(m.type)]}
                          {m.locked && m.status === "scheduled" ? " · locked" : ""}
                          {m.reason ? ` · ${m.reason}` : ""}
                        </p>
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${chipClasses(m)}`}>
                        {VISIT_LABELS.meetingStatus[m.status]}
                      </span>
                    </div>

                    {m.aiSummary && (
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600">{m.aiSummary}</p>
                    )}

                    {!readOnly && (moveId === m.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="date"
                          value={moveDate}
                          onChange={(e) => setMoveDate(e.target.value)}
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-brand-400"
                        />
                        <input
                          type="time"
                          value={moveTime}
                          onChange={(e) => setMoveTime(e.target.value)}
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-brand-400"
                        />
                        <button
                          onClick={() => moveDate && saveMove(m, moveDate, moveTime)}
                          className="rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white active:scale-95"
                        >
                          Save
                        </button>
                        <button onClick={() => setMoveId(null)} className="text-xs text-slate-400">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      (m.status === "scheduled" || m.status === "missed") && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {onRecord && venue && (
                            <ActionChip onClick={() => onRecord(venue, m)}>
                              <Mic className="h-3 w-3" /> Record
                            </ActionChip>
                          )}
                          <ActionChip onClick={() => openMove(m)}>Reschedule</ActionChip>
                          <ActionChip onClick={() => updateMeeting(m.id, { status: "cancelled" })}>Cancel</ActionChip>
                        </div>
                      )
                    ))}
                  </li>
                );
              })}
            </ul>
          )}

          {flaggedForDay.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Flagged to visit</p>
              <ul className="space-y-1.5">
                {flaggedForDay.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      {onOpenVenue ? (
                        <button
                          onClick={() => onOpenVenue(r.id)}
                          className="min-w-0 truncate text-sm font-medium text-slate-800 active:underline"
                        >
                          {r.name}
                        </button>
                      ) : (
                        <Link
                          href={`/restaurants/${r.id}`}
                          className="min-w-0 truncate text-sm font-medium text-slate-800 hover:underline"
                        >
                          {r.name}
                        </Link>
                      )}
                    </div>
                    {!readOnly && (
                      <button
                        onClick={() => updateRestaurant(r.id, { flaggedVisitDate: null })}
                        className="shrink-0 text-xs text-slate-400 active:text-slate-600"
                      >
                        Clear
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!readOnly && (
        <ScheduleVisitModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} defaultDateKey={selectedKey} lockDate />
      )}
    </div>
  );
}

function ActionChip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 active:scale-95"
    >
      {children}
    </button>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}
