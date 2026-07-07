"use client";

import { useState } from "react";
import { useSuggestions } from "@/lib/visits/useSuggestions";
import { suggestionBelongsToDay } from "@/lib/visits/suggestions";
import { toDateKey } from "@/lib/visits/dates";
import type { Meeting, Restaurant } from "@/lib/types";
import { CalendarGrid, type CalendarGridView } from "./CalendarGrid";
import { OverdueMeetingsPanel } from "./OverdueMeetingsPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";

// Desktop (and mobile-compact) calendar tab: the real-visits grid, an always-
// visible "did these happen?" nag for anything overdue, and a suggestions rail
// scoped to whatever the grid is currently showing — every suggestion coming
// up this month, or just the ones that land on a zoomed-in day.
export function RepCalendar({
  onRecord,
  onOpenVenue,
  compact = false,
  subject,
  readOnly = false,
}: {
  /** Open the record-meeting flow for a venue (optionally completing a
   * specific scheduled meeting). Hidden when not provided. */
  onRecord?: (venue: Restaurant, meeting?: Meeting) => void;
  /** Mobile: jump to the venue pin instead of navigating to the profile. */
  onOpenVenue?: (venueId: string) => void;
  compact?: boolean;
  /** Whose calendar to show. Defaults to the signed-in user; an admin viewing a
   * rep passes that rep here (with readOnly). */
  subject?: { id: string; name: string } | null;
  /** Read-only view — no booking, accepting, moving or recording. */
  readOnly?: boolean;
}) {
  const { suggestions, needsLogging, loading } = useSuggestions(subject ?? null);
  const [gridView, setGridView] = useState<CalendarGridView>("month");
  const [gridDay, setGridDay] = useState<string>(() => toDateKey(new Date()));

  const dayScoped = gridView === "day";
  const scopedSuggestions = dayScoped
    ? suggestions.filter((s) => suggestionBelongsToDay(s, new Date(gridDay + "T12:00:00")))
    : suggestions;

  const recordHandler = readOnly ? undefined : onRecord;

  return (
    <div className="space-y-4">
      <OverdueMeetingsPanel items={needsLogging} readOnly={readOnly} onRecord={readOnly ? undefined : (venue, meeting) => onRecord?.(venue, meeting)} />

      <CalendarGrid
        onRecord={recordHandler}
        onOpenVenue={onOpenVenue}
        compact={compact}
        subjectRepId={subject?.id}
        readOnly={readOnly}
        onViewChange={(view, dateKey) => {
          setGridView(view);
          setGridDay(dateKey);
        }}
      />

      <SuggestionsPanel
        suggestions={scopedSuggestions}
        loading={loading}
        readOnly={readOnly}
        defaultDateKey={dayScoped ? gridDay : undefined}
        title={dayScoped ? "Suggested for this day" : "Suggested visits"}
        emptyText={
          dayScoped
            ? "Nothing is due around this day — switch to Month to see everything coming up."
            : "Nothing due over the next few weeks. Venues appear here as they approach their usual visit interval, or if their sales drop off."
        }
      />
    </div>
  );
}
