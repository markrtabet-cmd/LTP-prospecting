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

export interface SuggestionsState {
  suggestions: Suggestion[];
  needsLogging: NeedsLoggingItem[];
  loading: boolean;
}

export function useSuggestions(): SuggestionsState {
  const { restaurants, loading: venuesLoading } = useRestaurants();
  const { meetings, loading: meetingsLoading, updateMeeting } = useMeetings();
  const { me, reps } = useRep();
  const [result, setResult] = useState<{ suggestions: Suggestion[]; needsLogging: NeedsLoggingItem[] }>({
    suggestions: [],
    needsLogging: [],
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (venuesLoading || meetingsLoading || !me) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rep: Rep = reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name };
      const venues = venuesForRep(restaurants, rep, reps);
      const { suggestions, needsLogging, missedIds } = buildSuggestions({ rep, venues, meetings });
      for (const id of missedIds) updateMeeting(id, { status: "missed" });
      setResult({ suggestions, needsLogging });
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [venuesLoading, meetingsLoading, me, reps, restaurants, meetings, updateMeeting]);

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
