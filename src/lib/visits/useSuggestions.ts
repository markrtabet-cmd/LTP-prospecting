"use client";

// Live suggestions driver: recomputes this rep's suggested visits + overdue
// "needs logging" list whenever the data they depend on changes (venues,
// frequencies, meetings booked/logged/moved/accepted), and sweeps confirmed
// visits past their grace window to status "missed". Debounced so a burst of
// changes settles into one recompute — same rhythm as the old silent
// auto-scheduler, just exposing a result instead of writing one.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRestaurants } from "@/lib/store";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import type { Rep } from "@/lib/types";
import { buildSuggestions, type NeedsLoggingItem, type Suggestion } from "./suggestions";
import { venuesForRep } from "./schedule";
import { applyDemoSalesOverlay } from "./demo-seed";

export interface SuggestionsState {
  suggestions: Suggestion[];
  needsLogging: NeedsLoggingItem[];
  loading: boolean;
}

export function useSuggestions(subject?: { id: string; name: string } | null): SuggestionsState {
  const { restaurants, loading: venuesLoading } = useRestaurants();
  const { meetings, loading: meetingsLoading, updateMeeting } = useMeetings();
  const { me, reps } = useRep();
  const [result, setResult] = useState<{ suggestions: Suggestion[]; needsLogging: NeedsLoggingItem[] }>({
    suggestions: [],
    needsLogging: [],
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whose calendar to compute. Reps: themselves. An admin viewing a rep passes
  // that rep as `subject` — and we DON'T write status changes back (their view
  // is read-only), so browsing a rep's calendar never mutates it.
  const subjectId = subject?.id ?? me?.id;
  const subjectName = subject?.name ?? me?.name;
  const viewOnly = Boolean(subject);

  useEffect(() => {
    if (venuesLoading || meetingsLoading || !subjectId || !subjectName) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rep: Rep = reps.find((r) => r.id === subjectId) ?? { id: subjectId, name: subjectName };
      // applyDemoSalesOverlay is a TEMP demo no-op unless the calendar demo
      // seed is on — see src/lib/visits/demo-seed.ts.
      const venues = applyDemoSalesOverlay(venuesForRep(restaurants, rep, reps));
      const { suggestions, needsLogging, missedIds } = buildSuggestions({ rep, venues, meetings });
      if (!viewOnly) for (const id of missedIds) updateMeeting(id, { status: "missed" });
      setResult({ suggestions, needsLogging });
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [venuesLoading, meetingsLoading, subjectId, subjectName, viewOnly, reps, restaurants, meetings, updateMeeting]);

  return useMemo(
    () => ({ suggestions: result.suggestions, needsLogging: result.needsLogging, loading: venuesLoading || meetingsLoading }),
    [result, venuesLoading, meetingsLoading],
  );
}

/** Just the overdue count, for ambient badges (e.g. the sidebar nav item).
 * Reuses the exact same computation as the calendar tab's panel, so the two
 * numbers can never disagree. */
export function useOverdueMeetingsCount(): number {
  const { needsLogging } = useSuggestions();
  return needsLogging.length;
}
