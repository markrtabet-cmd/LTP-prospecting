"use client";

import { useRef, useState } from "react";
import { CalendarDays, CalendarPlus, Sparkles, X } from "lucide-react";
import { useRep } from "@/lib/rep";
import { useSuggestions } from "@/lib/visits/useSuggestions";
import { suggestionBelongsToDay } from "@/lib/visits/suggestions";
import { toDateKey } from "@/lib/visits/dates";
import type { Meeting, Restaurant } from "@/lib/types";
import { CalendarGrid, type CalendarGridView } from "./CalendarGrid";
import { OverdueMeetingsPanel } from "./OverdueMeetingsPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { ScheduleVisitModal } from "./ScheduleVisitModal";

type Pane = "calendar" | "suggestions";
const SWIPE_THRESHOLD_PX = 56;

// Full-screen calendar for the mobile map — opened from the button under the
// Lumen icon. A slider at the top (tappable, and swipeable across the content)
// switches between two panes: the real-visits grid (month → day zoom), and
// suggested visits scoped to whatever the grid is currently showing.
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
  const { suggestions, needsLogging, loading } = useSuggestions();
  const [gridView, setGridView] = useState<CalendarGridView>("month");
  const [gridDay, setGridDay] = useState<string>(() => toDateKey(new Date()));
  const [pane, setPane] = useState<Pane>("calendar");
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const touchStartX = useRef<number | null>(null);
  const [dragPx, setDragPx] = useState(0);
  const dragging = touchStartX.current != null;

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (touchStartX.current == null) return;
    setDragPx(e.touches[0].clientX - touchStartX.current);
  }
  function onTouchEnd() {
    if (dragPx <= -SWIPE_THRESHOLD_PX && pane === "calendar") setPane("suggestions");
    else if (dragPx >= SWIPE_THRESHOLD_PX && pane === "suggestions") setPane("calendar");
    touchStartX.current = null;
    setDragPx(0);
  }

  const dayScoped = gridView === "day";
  const scopedSuggestions = dayScoped
    ? suggestions.filter((s) => suggestionBelongsToDay(s, new Date(gridDay + "T12:00:00")))
    : suggestions;
  const hasPending = suggestions.length > 0 || needsLogging.length > 0;

  const baseOffset = pane === "calendar" ? 0 : -50;
  const dragPct = dragging ? (dragPx / window.innerWidth) * 50 : 0;
  const offset = Math.max(-50, Math.min(0, baseOffset + dragPct));

  return (
    <div className="fixed inset-0 z-[1250] flex flex-col bg-slate-50">
      <div className="flex shrink-0 items-center justify-between bg-white px-4 py-3 shadow-sm">
        <div>
          <h2 className="text-base font-bold text-slate-900">{me ? `${me.name}'s calendar` : "Calendar"}</h2>
          <p className="text-xs text-slate-500">Real visits, plus suggestions from rhythm and sales</p>
        </div>
        <button onClick={onClose} className="p-2 text-slate-400 active:text-slate-700" aria-label="Close calendar">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Slider — tap either side, or swipe the content below */}
      <div className="flex shrink-0 gap-1 bg-white px-3 pb-2">
        <button
          onClick={() => setPane("calendar")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-colors ${
            pane === "calendar" ? "bg-brand-500 text-white" : "bg-slate-100 text-slate-500"
          }`}
        >
          <CalendarDays className="h-3.5 w-3.5" /> Calendar
        </button>
        <button
          onClick={() => setPane("suggestions")}
          className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-colors ${
            pane === "suggestions" ? "bg-brand-500 text-white" : "bg-slate-100 text-slate-500"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" /> Suggestions
          {hasPending && pane !== "suggestions" && (
            <span className="absolute right-3 top-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
          )}
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="flex h-full w-[200%] ease-out-soft"
          style={{ transform: `translateX(${offset}%)`, transition: dragging ? "none" : "transform 220ms" }}
        >
          <div className="h-full w-1/2 overflow-y-auto p-3">
            <CalendarGrid
              compact
              showRouteButton
              onRecord={onRecord}
              onOpenVenue={onOpenVenue}
              onViewChange={(view, dateKey) => {
                setGridView(view);
                setGridDay(dateKey);
              }}
            />
          </div>
          <div className="h-full w-1/2 space-y-3 overflow-y-auto p-3">
            <OverdueMeetingsPanel items={needsLogging} onRecord={onRecord} />
            <SuggestionsPanel
              suggestions={scopedSuggestions}
              loading={loading}
              defaultDateKey={dayScoped ? gridDay : undefined}
              title={dayScoped ? "Suggested for this day" : "Suggested visits"}
              emptyText={
                dayScoped
                  ? "Nothing due around this day — swipe to Calendar and pick Month to see everything coming up."
                  : "Nothing due over the next few weeks. Venues appear here as they approach their usual visit interval, or if their sales drop off."
              }
            />
          </div>
        </div>
      </div>

      {/* Schedule meeting — floating, reachable from either pane */}
      <button
        onClick={() => setScheduleOpen(true)}
        className="absolute bottom-6 right-4 z-10 flex items-center gap-1.5 rounded-full bg-brand-500 px-4 py-3 text-sm font-semibold text-white shadow-lg active:scale-95"
      >
        <CalendarPlus className="h-4 w-4" /> Schedule
      </button>

      <ScheduleVisitModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} defaultDateKey={gridDay} />
    </div>
  );
}
