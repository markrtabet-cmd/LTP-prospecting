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

  const load = useCallback(() => {
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
  }, []);

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
    window.addEventListener("focus", refresh);
    const interval = setInterval(refresh, 10 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(interval);
    };
  }, [configured]);

  // Persist locally ONLY in fallback mode.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (configured !== false) return;
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
  }, [meetings, configured]);

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
      setMeetings((prev) => [m, ...prev.filter((x) => x.id !== m.id)]);
      serverPost({ op: "upsertMany", items: [m] });
    },
    [serverPost],
  );

  const updateMeeting = useCallback(
    (id: string, patch: Partial<Meeting>) => {
      setMeetings((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
      serverPost({ op: "updateMany", patches: { [id]: patch } });
    },
    [serverPost],
  );

  const removeMeeting = useCallback(
    (id: string) => {
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
      // Nearest still-open (scheduled OR overdue-and-missed) meeting for this
      // venue+rep within the grace window — "the calendar detects the logged
      // meeting". Missed must match too: the overdue sweep flips a booking to
      // "missed" before the rep gets around to logging it, and logging it is
      // exactly how a missed booking gets resolved.
      const candidates = meetingsRef.current
        .filter(
          (m) =>
            m.venueId === input.venue.id &&
            m.repId === input.repId &&
            (m.status === "scheduled" || m.status === "missed"),
        )
        .map((m) => ({ m, dist: Math.abs(diffInDays(new Date(m.date), visitDate)) }))
        .filter((x) => x.dist <= RECONCILE_GRACE_DAYS)
        .sort((a, b) => a.dist - b.dist);

      const artefacts: Partial<Meeting> = {
        status: "completed",
        date: visitDate.toISOString(),
        type: input.type ?? "in_person",
        repName: input.repName,
        notes: input.notes,
        aiSummary: input.aiSummary,
        actionItems: input.actionItems,
        followUpRequired: input.followUpRequired,
        audioPath: input.audioPath,
        audioMimeType: input.audioMimeType,
        transcriptPath: input.transcriptPath,
      };

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
        type: input.type ?? "in_person",
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

  const value = useMemo(
    () => ({
      meetings,
      loading,
      shared: configured === true,
      needsTable,
      addMeeting,
      updateMeeting,
      removeMeeting,
      completeVisit,
      refresh: load,
    }),
    [meetings, loading, configured, needsTable, addMeeting, updateMeeting, removeMeeting, completeVisit, load],
  );

  return <MeetingsContext.Provider value={value}>{children}</MeetingsContext.Provider>;
}

export function useMeetings(): MeetingsValue {
  const ctx = useContext(MeetingsContext);
  if (!ctx) throw new Error("useMeetings must be used within MeetingsProvider");
  return ctx;
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
}): Meeting {
  return {
    id: newId("mtg"),
    repId: args.repId,
    repName: args.repName,
    venueId: args.venue.id,
    venueName: args.venue.name,
    date: fromDateKey(args.dateKey).toISOString(),
    type: args.type ?? "in_person",
    status: "scheduled",
    locked: true,
    source: args.source ?? "rep",
    reason: args.reason,
    notes: args.notes,
    createdAt: new Date().toISOString(),
  };
}

export { toDateKey };
