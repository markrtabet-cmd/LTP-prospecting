"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { buildScheduledMeeting, useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { MEETING_TYPES, VISIT_LABELS, type MeetingType } from "@/lib/visits/types";
import { toDateKey } from "@/lib/visits/dates";
import type { Restaurant } from "@/lib/types";

// "Book a visit myself" — a manually-booked meeting is a confirmed, locked
// entry on the grid, same as one created by accepting a suggestion.
export function ScheduleVisitModal({
  open,
  onClose,
  defaultDateKey,
  venue: presetVenue,
}: {
  open: boolean;
  onClose: () => void;
  defaultDateKey?: string;
  venue?: Restaurant | null;
}) {
  const { restaurants } = useRestaurants();
  const { addMeeting } = useMeetings();
  const { me } = useRep();

  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState<Restaurant | null>(presetVenue ?? null);
  const [dateKey, setDateKey] = useState(defaultDateKey ?? toDateKey(new Date()));
  const [type, setType] = useState<MeetingType>("in_person");
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

  if (!open) return null;

  function save() {
    if (!venue || !me || !dateKey) return;
    addMeeting(
      buildScheduledMeeting({
        repId: me.id,
        repName: me.name,
        venue,
        dateKey,
        type,
        notes: notes.trim() || undefined,
      }),
    );
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">Schedule a visit</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
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
                  <div className="mt-1 overflow-hidden rounded-xl ring-1 ring-slate-200">
                    {results.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setVenue(r); setQuery(""); }}
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

          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-slate-500">Date</label>
              <input
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
                className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
              />
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

          <button
            onClick={save}
            disabled={!venue || !dateKey}
            className="w-full rounded-xl bg-brand-500 py-3 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-40"
          >
            Book visit
          </button>
        </div>
      </div>
    </div>
  );
}
