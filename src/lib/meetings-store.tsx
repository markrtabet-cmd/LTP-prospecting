"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Meeting, Restaurant } from "@/lib/types";
import { RECONCILE_GRACE_DAYS } from "@/lib/visits/config";
import { diffInDays, fromDateKey, toDateKey } from "@/lib/visits/dates";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
import { DEMO_CALENDAR_SEED, buildDemoMeetings, isDemoMeetingId } from "@/lib/visits/demo-seed";

// Client-side store for calendar meetings — the same optimistic blob-sync
// pattern as the restaurants store: whole list in memory, mutations update
// state immediately and fire /api/meetings, refetch on focus + slow interval,
// localStorage fallback when Supabase (or the ltp_meetings table) is absent.

const STORAGE_KEY = "ltp_meetings_v1";

export interface CompleteVisitInput {
  repId: string;
  repName: string;
  venue: Restaurant;
  /** YYYY-MM-DD of the visit. */
  dateKey: string;
  /** When the rep is completing a SPECIFIC booking (opened the recorder from a
   * calendar entry / the overdue panel), its id — so that exact booking is
   * completed regardless of how far its booked date is from the logged date. */
  targetMeetingId?: string;
  type?: Meeting["type"];
  notes?: string;
  aiSummary?: string;
  actionItems?: string[];
  followUpRequired?: boolean;
  audioPath?: string;
  audioMimeType?: string;
  transcriptPath?: string;
}

interface MeetingsValue {
  meetings: Meeting[];
  loading: boolean;
  shared: boolean;
  needsTable: boolean;
  addMeeting: (m: Meeting) => void;
  updateMeeting: (id: string, patch: Partial<Meeting>) => void;
  removeMeeting: (id: string) => void;
  /**
   * Log a completed visit with reconciliation: if the rep has a scheduled
   * meeting for this venue within ±RECONCILE_GRACE_DAYS it is marked completed
   * (keeping its slot in history); otherwise a new completed meeting is added.
   * Returns the id of the completed meeting.
   */
  completeVisit: (input: CompleteVisitInput) => string;
  refresh: () => void;
}

const MeetingsContext = createContext<MeetingsValue | null>(null);

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function MeetingsProvider({ children }: { children: React.ReactNode }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [needsTable, setNeedsTable] = useState(false);
  const [loading, setLoading] = useState(true);

  // TEMP demo data — see src/lib/visits/demo-seed.ts to remove.
  const { me, sandbox } = useRep();
  const { restaurants } = useRestaurants();

  const load = useCallback(() => {
    // The developer sandbox gets a fresh, empty calendar and never touches the
    // shared meetings table — a clean slate to test bookings against.
    if (sandbox) {
      setConfigured(false);
      setMeetings([]);
      setLoading(false);
      return;
    }
    fetch("/api/meetings")
      .then((r) => r.json())
      .then((d: { configured?: boolean; needsTable?: boolean; meetings?: Meeting[] }) => {
        if (d?.configured) {
          setConfigured(true);
          setMeetings(d.meetings ?? []);
        } else {
          setConfigured(false);
          setNeedsTable(Boolean(d?.needsTable));
          try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) setMeetings(JSON.parse(raw) as Meeting[]);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => setConfigured(false))
      .finally(() => setLoading(false));
  }, [sandbox]);

  useEffect(load, [load]);

  // Keep shared state fresh (focus + 10 min), mirroring the restaurants store.
  useEffect(() => {
    if (configured !== true) return;
    const refresh = () => {
      fetch("/api/meetings")
        .then((r) => r.json())
        .then((d) => {
          if (d?.configured) setMeetings(d.meetings ?? []);
        })
        .catch(() => {});
    };
    // Also refetch on visibilitychange — reliable on mobile where `focus` often
    // doesn't fire when returning to the app, so a meeting booked on one device
    // shows on the other when you switch to it.
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(refresh, 2 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [configured]);

  // Persist locally ONLY in fallback mode. Never in the sandbox — its throwaway
  // test meetings must not overwrite a real local-dev calendar in this browser.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (configured !== false || sandbox) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(meetings));
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [meetings, configured, sandbox]);

  const serverPost = useCallback(
    (bodyObj: Record<string, unknown>) => {
      if (configured !== true) return;
      fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyObj),
      }).catch((e) => console.warn("LTP: meeting save failed", e));
    },
    [configured],
  );

  const addMeeting = useCallback(
    (m: Meeting) => {
      if (isDemoMeetingId(m.id)) return; // demo rows are display-only — never persist (see demo-seed)
      setMeetings((prev) => [m, ...prev.filter((x) => x.id !== m.id)]);
      serverPost({ op: "upsertMany", items: [m] });
    },
    [serverPost],
  );

  const updateMeeting = useCallback(
    (id: string, patch: Partial<Meeting>) => {
      if (isDemoMeetingId(id)) return; // demo rows are display-only — never persist
      setMeetings((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
      serverPost({ op: "updateMany", patches: { [id]: patch } });
    },
    [serverPost],
  );

  const removeMeeting = useCallback(
    (id: string) => {
      if (isDemoMeetingId(id)) return; // demo rows are display-only — never persist
      setMeetings((prev) => prev.filter((m) => m.id !== id));
      serverPost({ op: "remove", id });
    },
    [serverPost],
  );

  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;

  const completeVisit = useCallback(
    (input: CompleteVisitInput): string => {
      const visitDate = fromDateKey(input.dateKey);
      // Still-open (scheduled OR overdue-and-missed) bookings for this venue+rep —
      // "the calendar detects the logged meeting". A "missed" booking is BY
      // DEFINITION older than RECONCILE_GRACE_DAYS (it only flips to missed after
      // its grace window passes), so it must be matchable regardless of date
      // distance — otherwise recording a late catch-up would fork a duplicate and
      // leave the booking nagging as overdue forever. A still-"scheduled" booking
      // keeps the tighter grace window (only a nearby booking is "the same visit").
      const candidates = meetingsRef.current
        .filter(
          (m) =>
            m.venueId === input.venue.id &&
            m.repId === input.repId &&
            (m.status === "scheduled" || m.status === "missed"),
        )
        .map((m) => ({ m, dist: Math.abs(diffInDays(new Date(m.date), visitDate)) }))
        .filter((x) => x.m.status === "missed" || x.dist <= RECONCILE_GRACE_DAYS)
        .sort((a, b) => a.dist - b.dist);

      const artefacts: Partial<Meeting> = {
        status: "completed",
        date: visitDate.toISOString(),
        type: input.type ?? "visit",
        repName: input.repName,
        notes: input.notes,
        aiSummary: input.aiSummary,
        actionItems: input.actionItems,
        followUpRequired: input.followUpRequired,
        audioPath: input.audioPath,
        audioMimeType: input.audioMimeType,
        transcriptPath: input.transcriptPath,
      };

      // When the recorder was opened for a SPECIFIC booking, complete that exact
      // one — the rep's explicit choice wins over date-proximity guessing.
      if (input.targetMeetingId) {
        const target = meetingsRef.current.find(
          (m) =>
            m.id === input.targetMeetingId &&
            (m.status === "scheduled" || m.status === "missed"),
        );
        if (target) {
          updateMeeting(target.id, artefacts);
          return target.id;
        }
      }

      if (candidates.length > 0) {
        const target = candidates[0].m;
        updateMeeting(target.id, artefacts);
        return target.id;
      }

      const id = newId("mtg");
      addMeeting({
        id,
        repId: input.repId,
        repName: input.repName,
        venueId: input.venue.id,
        venueName: input.venue.name,
        date: visitDate.toISOString(),
        type: input.type ?? "visit",
        status: "completed",
        locked: false,
        source: "rep",
        notes: input.notes,
        aiSummary: input.aiSummary,
        actionItems: input.actionItems,
        followUpRequired: input.followUpRequired,
        audioPath: input.audioPath,
        audioMimeType: input.audioMimeType,
        transcriptPath: input.transcriptPath,
        createdAt: new Date().toISOString(),
      });
      return id;
    },
    [addMeeting, updateMeeting],
  );

  // TEMP: merge display-only demo meetings for the signed-in rep. Merged at the
  // value layer (not into state), so a server refetch never wipes them and they
  // never enter any write path. Delete this + the demo-seed file to remove.
  const demoMeetings = useMemo(
    () => (DEMO_CALENDAR_SEED && me ? buildDemoMeetings(me.id, me.name, restaurants) : []),
    [me, restaurants],
  );
  const allMeetings = useMemo(
    () => (demoMeetings.length ? [...demoMeetings, ...meetings] : meetings),
    [demoMeetings, meetings],
  );

  const value = useMemo(
    () => ({
      meetings: allMeetings,
      loading,
      shared: configured === true,
      needsTable,
      addMeeting,
      updateMeeting,
      removeMeeting,
      completeVisit,
      refresh: load,
    }),
    [allMeetings, loading, configured, needsTable, addMeeting, updateMeeting, removeMeeting, completeVisit, load],
  );

  return <MeetingsContext.Provider value={value}>{children}</MeetingsContext.Provider>;
}

export function useMeetings(): MeetingsValue {
  const ctx = useContext(MeetingsContext);
  if (!ctx) throw new Error("useMeetings must be used within MeetingsProvider");
  return ctx;
}

/** A "check how they liked the samples" follow-up visit — the same booking on
 * both the mobile map sheet and the desktop contact log, so the calendar entry
 * reads identically wherever the rep logged "Samples sent". */
export function buildSamplesFollowUp(args: {
  repId: string;
  repName: string;
  venue: Restaurant;
  dateKey: string;
  notes?: string;
}): Meeting {
  return buildScheduledMeeting({
    repId: args.repId,
    repName: args.repName,
    venue: args.venue,
    dateKey: args.dateKey,
    type: "visit",
    reason: "Follow up on samples sent",
    notes: args.notes?.trim() || "Check how they liked the samples.",
  });
}

/** Helper for building a manual (rep-created, locked) scheduled meeting. */
export function buildScheduledMeeting(args: {
  repId: string;
  repName: string;
  venue: Restaurant;
  dateKey: string;
  type?: Meeting["type"];
  notes?: string;
  source?: Meeting["source"];
  reason?: string;
  /** Optional time-of-day "HH:mm" (24h) — day-only when omitted. */
  startTime?: string;
  durationMinutes?: number;
}): Meeting {
  return {
    id: newId("mtg"),
    repId: args.repId,
    repName: args.repName,
    venueId: args.venue.id,
    venueName: args.venue.name,
    date: fromDateKey(args.dateKey).toISOString(),
    startTime: args.startTime,
    durationMinutes: args.durationMinutes,
    type: args.type ?? "visit",
    status: "scheduled",
    locked: true,
    source: args.source ?? "rep",
    reason: args.reason,
    notes: args.notes,
    createdAt: new Date().toISOString(),
  };
}

export { toDateKey };
