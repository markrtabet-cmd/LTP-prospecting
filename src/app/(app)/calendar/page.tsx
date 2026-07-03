"use client";

import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { RepCalendar } from "@/components/visits/RepCalendar";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { useRep } from "@/lib/rep";
import type { Meeting, Restaurant } from "@/lib/types";

// Desktop calendar page (reached from the icon on the map — phones get the
// same calendar as a sheet inside the mobile map). One calendar per rep: it
// auto-arranges itself around locked bookings and visit quotas.
export default function CalendarPage() {
  const { me } = useRep();
  const [recording, setRecording] = useState<{ venue: Restaurant; meeting?: Meeting } | null>(null);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={me ? `${me.name}'s calendar` : "Calendar"}
        subtitle="Auto-planned visits around your locked bookings — log or record a meeting and the day ticks itself off"
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
