"use client";

import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { RepCalendar } from "@/components/visits/RepCalendar";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { useRep } from "@/lib/rep";
import type { Meeting, Restaurant } from "@/lib/types";

// Desktop calendar page (also in the sidebar nav — phones get the same
// calendar as a sheet inside the mobile map). One calendar per rep: real,
// confirmed visits on the grid, plus suggested visits it recommends based on
// visit rhythm and Power BI sales signals — nothing books itself until it's
// accepted.
export default function CalendarPage() {
  const { me } = useRep();
  const [recording, setRecording] = useState<{ venue: Restaurant; meeting?: Meeting } | null>(null);

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
