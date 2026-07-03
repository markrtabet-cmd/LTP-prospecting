"use client";

// Silent re-flow driver: whenever the data the plan depends on changes (venues,
// frequencies, meetings logged/locked/moved), recompute this rep's fluid
// schedule and persist it — but only when the plan actually changed, so the
// store isn't spammed and the loop (replaceScheduled → meetings change →
// effect) settles immediately.

import { useEffect, useRef } from "react";
import { useRestaurants } from "@/lib/store";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import type { Rep } from "@/lib/types";
import { planSchedule, planSignature } from "./scheduler";
import { venuesForRep } from "./schedule";

export function useAutoSchedule(enabled: boolean) {
  const { restaurants, loading: venuesLoading } = useRestaurants();
  const { meetings, loading: meetingsLoading, updateMeeting, replaceScheduled } = useMeetings();
  const { me, reps } = useRep();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || venuesLoading || meetingsLoading || !me) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rep: Rep = reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name };
      const venues = venuesForRep(restaurants, rep, reps);
      const { plan, missedIds } = planSchedule({ rep, venues, meetings });

      for (const id of missedIds) updateMeeting(id, { status: "missed" });

      const current = planSignature(meetings.filter((m) => m.repId === me.id));
      const next = planSignature(plan);
      if (current !== next) replaceScheduled(me.id, plan);
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, venuesLoading, meetingsLoading, me, reps, restaurants, meetings, updateMeeting, replaceScheduled]);
}
