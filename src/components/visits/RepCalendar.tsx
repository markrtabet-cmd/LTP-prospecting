"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarPlus, ChevronLeft, ChevronRight, Lock, Mic, Sparkles } from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
import { useAutoSchedule } from "@/lib/visits/useAutoSchedule";
import {
  addMonths,
  fmtMonthYear,
  fmtShortDay,
  isSameDay,
  isSameMonth,
  monthGridDays,
  startOfMonth,
  toDateKey,
} from "@/lib/visits/dates";
import { VISIT_LABELS } from "@/lib/visits/types";
import type { Meeting, Restaurant } from "@/lib/types";
import { ScheduleVisitModal } from "./ScheduleVisitModal";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function chipClasses(m: Meeting): string {
  if (m.status === "completed") return "bg-green-100 text-green-800";
  if (m.status === "missed") return "bg-red-100 text-red-700";
  if (m.locked) return "bg-indigo-100 text-indigo-800"; // booked / follow-up commitment
  return "bg-blue-100 text-blue-800"; // auto-planned
}

// Each rep's own month calendar: auto-planned visits (blue), their own locked
// bookings + AI follow-up commitments (indigo), completed (green), missed
// (red). Opening it triggers the silent re-flow.
export function RepCalendar({
  onRecord,
  onOpenVenue,
  compact = false,
}: {
  /** Open the record-meeting flow for a venue (optionally completing a
   * specific scheduled meeting). Hidden when not provided. */
  onRecord?: (venue: Restaurant, meeting?: Meeting) => void;
  /** Mobile: jump to the venue pin instead of navigating to the profile. */
  onOpenVenue?: (venueId: string) => void;
  compact?: boolean;
}) {
  useAutoSchedule(true);
  const { meetings, updateMeeting, removeMeeting } = useMeetings();
  const { me } = useRep();
  const { restaurants } = useRestaurants();

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [selectedKey, setSelectedKey] = useState<string>(() => toDateKey(new Date()));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [moveId, setMoveId] = useState<string | null>(null);

  const today = new Date();
  const days = useMemo(() => monthGridDays(cursor), [cursor]);

  const mine = useMemo(
    () => meetings.filter((m) => m.repId === me?.id && m.status !== "cancelled"),
    [meetings, me?.id],
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

  const selectedMeetings = byDay.get(selectedKey) ?? [];
  const venueById = useMemo(() => new Map(restaurants.map((r) => [r.id, r])), [restaurants]);

  function move(m: Meeting, dateKey: string) {
    // A moved visit is a rep decision → it locks in place.
    updateMeeting(m.id, {
      date: new Date(dateKey + "T12:00:00").toISOString(),
      locked: true,
      source: m.source === "scheduler" ? "rep" : m.source,
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
          {fmtMonthYear(cursor)}
        </h2>
        <div className="flex items-center gap-1">
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => setCursor((c) => addMonths(c, -1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            onClick={() => { setCursor(startOfMonth(new Date())); setSelectedKey(toDateKey(new Date())); }}
          >
            Today
          </button>
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => setCursor((c) => addMonths(c, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-500">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1.5">{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = toDateKey(day);
          const dayMeetings = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, cursor);
          const isSelected = key === selectedKey;
          const maxChips = compact ? 2 : 3;
          return (
            <button
              key={key}
              onClick={() => setSelectedKey(key)}
              className={`${compact ? "min-h-[64px]" : "min-h-[92px]"} border-b border-r border-slate-100 p-1 text-left align-top ${
                inMonth ? "bg-white" : "bg-slate-50/60"
              } ${isSelected ? "ring-2 ring-inset ring-brand-400" : ""}`}
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
        <Legend className="bg-blue-400" label="Auto-planned" />
        <Legend className="bg-indigo-400" label="Booked (locked)" />
        <Legend className="bg-green-400" label="Done" />
        <Legend className="bg-red-400" label="Missed" />
      </div>

      {/* Day detail */}
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {fmtShortDay(new Date(selectedKey + "T12:00:00"))}
          </p>
          <button
            onClick={() => setScheduleOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white active:scale-95"
          >
            <CalendarPlus className="h-3.5 w-3.5" /> Book visit
          </button>
        </div>

        {selectedMeetings.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
            Nothing planned — a light day is prospecting time.
          </p>
        ) : (
          <ul className="space-y-2">
            {selectedMeetings.map((m) => {
              const venue = venueById.get(m.venueId);
              return (
                <li key={m.id} className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
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
                        {VISIT_LABELS.meetingType[m.type]}
                        {m.locked && m.status === "scheduled" ? " · locked" : ""}
                        {m.reason ? ` · ${m.reason}` : ""}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${chipClasses(m)}`}>
                      {VISIT_LABELS.meetingStatus[m.status]}
                    </span>
                  </div>

                  {m.aiSummary && (
                    <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600">{m.aiSummary}</p>
                  )}

                  {moveId === m.id ? (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="date"
                        defaultValue={toDateKey(new Date(m.date))}
                        onChange={(e) => e.target.value && move(m, e.target.value)}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none"
                      />
                      <button onClick={() => setMoveId(null)} className="text-xs text-slate-400">Cancel</button>
                    </div>
                  ) : (
                    (m.status === "scheduled" || m.status === "missed") && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {onRecord && venue && (
                          <ActionChip onClick={() => onRecord(venue, m)}>
                            <Mic className="h-3 w-3" /> Record
                          </ActionChip>
                        )}
                        <ActionChip onClick={() => setMoveId(m.id)}>Move</ActionChip>
                        {m.status === "scheduled" && !m.locked && (
                          <ActionChip onClick={() => updateMeeting(m.id, { locked: true, source: "rep", reason: undefined })}>
                            Lock day
                          </ActionChip>
                        )}
                        {/* Removing an auto-planned visit is pointless — the
                            planner would put it straight back. Locked bookings
                            can be cancelled; the venue returns to the fluid pool. */}
                        {(m.locked || m.source !== "scheduler") && (
                          <ActionChip
                            onClick={() =>
                              m.source === "scheduler"
                                ? removeMeeting(m.id)
                                : updateMeeting(m.id, { status: "cancelled" })
                            }
                          >
                            Cancel
                          </ActionChip>
                        )}
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ScheduleVisitModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        defaultDateKey={selectedKey}
      />
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
