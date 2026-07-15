"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { buildScheduledMeeting, useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { MEETING_TYPES, VISIT_LABELS, type MeetingType } from "@/lib/visits/types";
import { fmtShortDay, fmtTime, suggestVisitTime, toDateKey } from "@/lib/visits/dates";
import type { Restaurant } from "@/lib/types";

// "Book a visit myself" — a manually-booked meeting is a confirmed, locked
// entry on the grid, same as one created by accepting a suggestion.
export function ScheduleVisitModal({
  open,
  onClose,
  defaultDateKey,
  venue: presetVenue,
  lockDate = false,
}: {
  open: boolean;
  onClose: () => void;
  defaultDateKey?: string;
  venue?: Restaurant | null;
  /** Booked from a specific day (day view): pin to defaultDateKey, hide the
   * date field — the rep already chose the day by being on it. */
  lockDate?: boolean;
}) {
  const { restaurants } = useRestaurants();
  const { addMeeting, meetings } = useMeetings();
  const { me } = useRep();

  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState<Restaurant | null>(presetVenue ?? null);
  const [dateKey, setDateKey] = useState(defaultDateKey ?? toDateKey(new Date()));
  const [startTime, setStartTime] = useState("");
  const [type, setType] = useState<MeetingType>("visit");
  const [notes, setNotes] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const customers: Restaurant[] = [];
    const others: Restaurant[] = [];
    for (const r of restaurants) {
      if (!r.name.toLowerCase().includes(q)) continue;
      (r.existingCustomer ? customers : others).push(r);
      if (customers.length >= 6) break;
    }
    return [...customers, ...others].slice(0, 6);
  }, [query, restaurants]);

  const venueById = useMemo(() => new Map(restaurants.map((r) => [r.id, r])), [restaurants]);

  // A smart time for a new visit on `key`, given that day's booked visits and
  // the chosen venue's location. undefined = nothing to anchor to (empty day) —
  // we then leave the time blank rather than inventing one.
  function suggestFor(key: string, v: Restaurant | null): string | undefined {
    const lite = meetings
      .filter((m) => m.repId === me?.id && m.status !== "cancelled" && toDateKey(new Date(m.date)) === key)
      .map((m) => {
        const rv = venueById.get(m.venueId);
        return { startTime: m.startTime, lat: rv?.latitude, lng: rv?.longitude };
      });
    return suggestVisitTime(lite, v ? { lat: v.latitude, lng: v.longitude } : null);
  }
  // Point the form at a day and offer that day's smart slot as the time.
  function applyDate(key: string) {
    setDateKey(key);
    setStartTime(suggestFor(key, venue) ?? "");
  }
  const suggested = useMemo(() => suggestFor(dateKey, venue), [meetings, me?.id, dateKey, venue, venueById]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-seed the day + suggested time whenever the sheet opens (or the day it was
  // opened for changes). Manual edits persist until the next open/day change.
  useEffect(() => {
    if (open) applyDate(defaultDateKey ?? toDateKey(new Date()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultDateKey]);

  if (!open || typeof document === "undefined") return null;

  function save() {
    if (!venue || !me || !dateKey) return;
    addMeeting(
      buildScheduledMeeting({
        repId: me.id,
        repName: me.name,
        venue,
        dateKey,
        type,
        startTime: startTime || undefined,
        notes: notes.trim() || undefined,
      }),
    );
    onClose();
  }

  return createPortal(
    // Full-screen sheet on mobile (header/search pinned at the TOP so the
    // on-screen keyboard can't push them off — a bottom sheet fights the iOS
    // keyboard and vh units), a centred dialog from sm up.
    <div className="fixed inset-0 z-[1400] bg-black/40 sm:flex sm:items-center sm:justify-center sm:p-4" onClick={onClose}>
      <div
        className="flex h-full w-full flex-col bg-white shadow-2xl sm:h-auto sm:max-h-[88vh] sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-bold text-slate-900">Schedule a visit</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs text-slate-500">Venue</label>
            {venue ? (
              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate font-medium text-slate-800">{venue.name}</span>
                {!presetVenue && (
                  <button onClick={() => setVenue(null)} className="shrink-0 text-xs text-brand-600 hover:underline">
                    Change
                  </button>
                )}
              </div>
            ) : (
              <>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search venues…"
                  autoFocus
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
                />
                {results.length > 0 && (
                  <div className="mt-1 max-h-[38vh] overflow-y-auto rounded-xl ring-1 ring-slate-200">
                    {results.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setVenue(r); setQuery(""); setStartTime(suggestFor(dateKey, r) ?? ""); }}
                        className="flex w-full items-center justify-between border-b border-slate-100 bg-white px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50"
                      >
                        <span className="min-w-0 truncate">{r.name}</span>
                        {r.existingCustomer && (
                          <span className="ml-2 shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">Customer</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-500">Date</label>
            {lockDate ? (
              <div className="flex h-11 items-center rounded-xl bg-slate-50 px-3 text-sm font-medium text-slate-700">
                {fmtShortDay(new Date(dateKey + "T12:00:00"))}
              </div>
            ) : (
              <input
                type="date"
                value={dateKey}
                onChange={(e) => e.target.value && applyDate(e.target.value)}
                className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-slate-500">Time</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
              />
              {suggested && startTime !== suggested && (
                <button
                  onClick={() => setStartTime(suggested)}
                  className="mt-1 text-[11px] font-medium text-brand-600 active:text-brand-700"
                >
                  Suggested {fmtTime(suggested)} · tap to use
                </button>
              )}
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-slate-500">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as MeetingType)}
                className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
              >
                {MEETING_TYPES.map((t) => (
                  <option key={t} value={t}>{VISIT_LABELS.meetingType[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-500">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. bring seasonal samples"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
            />
          </div>

          <p className="text-xs text-slate-400">This books it straight onto the calendar as a confirmed visit.</p>
        </div>

        <div className="shrink-0 border-t border-slate-100 px-5 py-4">
          <button
            onClick={save}
            disabled={!venue || !dateKey}
            className="w-full rounded-xl bg-brand-500 py-3 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-40"
          >
            Book visit
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
