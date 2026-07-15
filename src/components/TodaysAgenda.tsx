"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { toDateKey } from "@/lib/visits/dates";
import { type MeetingType, normalizeMeetingType } from "@/lib/visits/types";

// "Today's calendar" — the dashboard's day view: what's booked today and what's
// coming up next, for the signed-in rep. Bookings are day-precision (the
// calendar doesn't store a clock time), so this shows the day, not the hour.
// Replaces the old outreach-drafts panel.

const TYPE_LABEL: Record<MeetingType, string> = {
  visit: "Visit",
  meeting: "Meeting",
  call: "Phone call",
};

const UPCOMING_LIMIT = 4;

function dayLabel(dateKey: string, todayKey: string): string {
  const d = new Date(dateKey + "T12:00:00");
  const t = new Date(todayKey + "T12:00:00");
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function TodaysAgenda() {
  const { meetings, loading } = useMeetings();
  const { me } = useRep();
  const todayKey = toDateKey(new Date());

  const scheduled = useMemo(() => {
    const open = meetings.filter((m) => m.status === "scheduled");
    return me ? open.filter((m) => m.repId === me.id) : open;
  }, [meetings, me]);

  const today = useMemo(
    () =>
      scheduled
        .filter((m) => toDateKey(new Date(m.date)) === todayKey)
        .sort((a, b) => a.venueName.localeCompare(b.venueName)),
    [scheduled, todayKey],
  );

  const upcoming = useMemo(
    () =>
      scheduled
        .filter((m) => toDateKey(new Date(m.date)) > todayKey)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, UPCOMING_LIMIT),
    [scheduled, todayKey],
  );

  return (
    <div
      className="anim-rise rounded-xl bg-white p-5 shadow-sm transition-shadow duration-150 hover:shadow-md"
      style={{ "--rise-delay": "480ms" } as React.CSSProperties}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-slate-900">
          <CalendarDays size={16} className="text-brand-600" />
          Today&apos;s calendar
        </h2>
        <Link href="/calendar" className="text-xs font-medium text-brand-600 hover:underline">
          Open calendar
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Loading your day…</p>
      ) : (
        <>
          {today.length === 0 ? (
            <div className="rounded-lg bg-slate-50 px-3 py-4 text-center">
              <p className="text-sm font-medium text-slate-600">Nothing booked today</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {me ? "Enjoy the breathing room, or line up a visit." : "Sign in to see your own visits."}
              </p>
            </div>
          ) : (
            <ul className="-mx-2 divide-y divide-slate-100">
              {today.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2.5 transition-colors duration-150 hover:bg-slate-50">
                  <div className="min-w-0">
                    <Link href={`/restaurants/${m.venueId}`} className="block truncate text-sm font-medium text-slate-800 transition-colors duration-150 hover:text-brand-600">
                      {m.venueName}
                    </Link>
                    <p className="truncate text-xs text-slate-400">{TYPE_LABEL[normalizeMeetingType(m.type)]}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Today</span>
                </li>
              ))}
            </ul>
          )}

          {upcoming.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mb-2 text-xs font-medium text-slate-400">Coming up</p>
              <ul className="space-y-1.5">
                {upcoming.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/restaurants/${m.venueId}`} className="min-w-0 truncate text-slate-700 transition-colors duration-150 hover:text-brand-600">
                      {m.venueName}
                    </Link>
                    <span className="shrink-0 text-xs font-medium text-slate-500">
                      {dayLabel(toDateKey(new Date(m.date)), todayKey)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
