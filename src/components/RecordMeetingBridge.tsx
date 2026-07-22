"use client";

import { useEffect, useRef, useState } from "react";
import { useRestaurants } from "@/lib/store";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import type { Restaurant } from "@/lib/types";

// Opens the meeting recorder in response to Lumen's `record_meeting` action,
// which dispatches a window "ltp:record-meeting" event. Mounted once in the app
// layout so it works on EVERY surface — including desktop, where the mobile map
// (the previous sole listener) isn't mounted, so "record my meeting" silently
// did nothing. The recorder is a full-screen overlay, so it's fine everywhere.
export function RecordMeetingBridge() {
  const { restaurants } = useRestaurants();
  const venuesRef = useRef(restaurants);
  venuesRef.current = restaurants;
  const [venue, setVenue] = useState<Restaurant | null>(null);

  useEffect(() => {
    function onEvent(e: Event) {
      const id = (e as CustomEvent<{ venueId?: string }>).detail?.venueId;
      const v = venuesRef.current.find((r) => r.id === id) ?? null;
      if (v) setVenue(v);
    }
    window.addEventListener("ltp:record-meeting", onEvent);
    return () => window.removeEventListener("ltp:record-meeting", onEvent);
  }, []);

  if (!venue) return null;
  return <RecordMeetingSheet venue={venue} onClose={() => setVenue(null)} />;
}
