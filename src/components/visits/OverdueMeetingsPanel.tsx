"use client";

import { useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Mic, X } from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { useRestaurants } from "@/lib/store";
import { fmtShortDay, fromDateKey, toDateKey } from "@/lib/visits/dates";
import type { Meeting, Restaurant } from "@/lib/types";
import { isAdhocMeeting } from "@/lib/types";
import type { NeedsLoggingItem } from "@/lib/visits/suggestions";

// Confirmed visits whose date + grace window has passed unrecorded. Pinned at
// the top of both the desktop and mobile calendar — a meeting only counts as
// done once it's recorded, so this keeps resurfacing daily until the rep logs
// it, reschedules it, or skips it outright.
export function OverdueMeetingsPanel({
  items,
  onRecord,
  readOnly = false,
}: {
  items: NeedsLoggingItem[];
  /** Omitted (or readOnly) for an admin's read-only view of a rep's calendar. */
  onRecord?: (venue: Restaurant | null, meeting: Meeting) => void;
  readOnly?: boolean;
}) {
  const { meetings, updateMeeting } = useMeetings();
  const { restaurants } = useRestaurants();
  const [rescheduleFor, setRescheduleFor] = useState<string | null>(null);
  const [newDate, setNewDate] = useState("");

  if (items.length === 0) return null;

  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const venueById = new Map(restaurants.map((r) => [r.id, r]));

  function reschedule(meetingId: string, dateKey: string) {
    updateMeeting(meetingId, { date: fromDateKey(dateKey).toISOString(), status: "scheduled" });
    setRescheduleFor(null);
  }

  return (
    <div className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        <h3 className="text-sm font-semibold text-slate-900">Did these visits happen?</h3>
        <span className="text-xs text-slate-500">booked, but not recorded yet</span>
      </div>
      <div className="space-y-2">
        {items.map((it) => {
          const meeting = meetingById.get(it.meetingId);
          const venue = venueById.get(it.venueId);
          return (
            <div key={it.meetingId} className="rounded-xl bg-white px-3 py-2.5 ring-1 ring-amber-100">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{it.venueName}</p>
                  <p className="text-xs text-slate-500">
                    booked for {fmtShortDay(new Date(it.scheduledDate))} ·{" "}
                    {it.daysOverdue === 1 ? "1 day overdue" : `${it.daysOverdue} days overdue`}
                  </p>
                </div>
                {!readOnly && (
                  <>
                    {meeting && (venue || isAdhocMeeting(meeting)) && onRecord && (
                      <button
                        onClick={() => onRecord(venue ?? null, meeting)}
                        className="flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white active:scale-95"
                      >
                        <Mic className="h-3.5 w-3.5" /> Log it
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setNewDate(toDateKey(new Date()));
                        setRescheduleFor(rescheduleFor === it.meetingId ? null : it.meetingId);
                      }}
                      className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 active:scale-95"
                    >
                      <CalendarIcon className="h-3.5 w-3.5" /> Reschedule
                    </button>
                    <button
                      onClick={() => updateMeeting(it.meetingId, { status: "cancelled" })}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 active:text-red-600"
                      title="It didn't happen — skip it"
                    >
                      <X className="h-3.5 w-3.5" /> Skip
                    </button>
                  </>
                )}
              </div>

              {!readOnly && rescheduleFor === it.meetingId && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-xs text-slate-500">New date:</span>
                  <input
                    type="date"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none"
                  />
                  <button
                    onClick={() => newDate && reschedule(it.meetingId, newDate)}
                    className="rounded-lg bg-brand-500 px-2.5 py-1 text-xs font-semibold text-white active:scale-95"
                  >
                    Move
                  </button>
                  <button onClick={() => setRescheduleFor(null)} className="text-xs text-slate-400">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
