"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PublicRep } from "./users";
import type { Rep } from "./types";

// Client-side identity + roster. The session cookie is httpOnly, so the UI
// learns "who am I" from /api/me once per load; the roster (/api/users) feeds
// rep↔venue matching and the transcription glossary.

interface RepValue {
  /** Signed-in rep (null while loading or if the session somehow expired). */
  me: { id: string; name: string } | null;
  /** Full team roster (public shape — no password material). */
  reps: Rep[];
  loading: boolean;
  refreshRoster: () => void;
}

const RepContext = createContext<RepValue | null>(null);

export function RepProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshRoster = useCallback(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d: { users?: PublicRep[] }) => {
        if (Array.isArray(d.users)) {
          setReps(d.users.map((u) => ({ id: u.id, name: u.name, aliases: u.aliases })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { id?: string; name?: string } | null) => {
        if (!cancelled && d?.id && d?.name) setMe({ id: d.id, name: d.name });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    refreshRoster();
    return () => {
      cancelled = true;
    };
  }, [refreshRoster]);

  const value = useMemo(
    () => ({ me, reps, loading, refreshRoster }),
    [me, reps, loading, refreshRoster],
  );
  return <RepContext.Provider value={value}>{children}</RepContext.Provider>;
}

export function useRep(): RepValue {
  const ctx = useContext(RepContext);
  if (!ctx) throw new Error("useRep must be used within RepProvider");
  return ctx;
}
