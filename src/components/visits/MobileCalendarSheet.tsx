"use client";

import { X } from "lucide-react";
import { RepCalendar } from "./RepCalendar";
import { useRep } from "@/lib/rep";
import type { Meeting, Restaurant } from "@/lib/types";

// Full-screen calendar for the mobile map — opened from the button under the
// Lumen icon. The map stays the main surface; this slides over it.
export function MobileCalendarSheet({
  onClose,
  onRecord,
  onOpenVenue,
}: {
  onClose: () => void;
  onRecord: (venue: Restaurant, meeting?: Meeting) => void;
  onOpenVenue: (venueId: string) => void;
}) {
  const { me } = useRep();
  return (
    <div className="fixed inset-0 z-[1250] flex flex-col bg-slate-50">
      <div className="flex shrink-0 items-center justify-between bg-white px-4 py-3 shadow-sm">
        <div>
          <h2 className="text-base font-bold text-slate-900">{me ? `${me.name}'s calendar` : "Calendar"}</h2>
          <p className="text-xs text-slate-500">Auto-planned around your locked bookings</p>
        </div>
        <button onClick={onClose} className="p-2 text-slate-400 active:text-slate-700" aria-label="Close calendar">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RepCalendar compact onRecord={onRecord} onOpenVenue={onOpenVenue} />
      </div>
    </div>
  );
}
