"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { RepCalendar } from "@/components/visits/RepCalendar";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { useRep } from "@/lib/rep";
import type { Meeting, Restaurant } from "@/lib/types";

// Desktop calendar page (also in the sidebar nav — phones get the same
// calendar as a sheet inside the mobile map).
//
//   • Reps (and the developer sandbox) get their OWN calendar: real, confirmed
//     visits on the grid, plus suggested visits below, ready to accept.
//   • Admins have no calendar of their own — they switch between the reps'
//     calendars to oversee them, read-only.
export default function CalendarPage() {
  const { me, role, sandbox, salesReps, viewRepId, setViewRepId } = useRep();
  const [recording, setRecording] = useState<{ venue: Restaurant | null; meeting?: Meeting } | null>(null);

  const ownCalendar = role === "rep" || sandbox;

  const selectedRep = useMemo(() => {
    // "" is the site-wide "Whole company" choice; the calendar has no company
    // view, so fall back to the first rep (|| catches both "" and null).
    const id = viewRepId || salesReps[0]?.id;
    return salesReps.find((r) => r.id === id) ?? salesReps[0] ?? null;
  }, [viewRepId, salesReps]);

  if (ownCalendar) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title={me ? `${me.name}'s calendar` : "Calendar"}
          subtitle="Real visits on the grid; suggested visits below, ready to accept or rearrange"
        />
        <RepCalendar onRecord={(venue, meeting) => setRecording({ venue, meeting })} />
        {recording && (
          <RecordMeetingSheet
            venue={recording.venue}
            scheduledMeeting={recording.meeting}
            onClose={() => setRecording(null)}
          />
        )}
      </div>
    );
  }

  // Admin / read-only oversight view.
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={selectedRep ? `${selectedRep.name}'s calendar` : "Team calendars"}
        subtitle="Switch between the reps to see their booked and suggested visits"
        action={
          <select
            value={selectedRep?.id ?? ""}
            onChange={(e) => setViewRepId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm"
          >
            {salesReps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        }
      />
      {selectedRep ? (
        <RepCalendar subject={selectedRep} readOnly />
      ) : (
        <p className="rounded-xl bg-white p-10 text-center text-sm text-slate-400 ring-1 ring-slate-200">
          No sales reps on the roster yet.
        </p>
      )}
    </div>
  );
}
