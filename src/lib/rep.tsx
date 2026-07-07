"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PublicRep } from "./users";
import type { Rep } from "./types";
import { TEAM_ACCOUNTS, seesEverything, type Role } from "./team-accounts";

// Client-side identity + roster. The session cookie is httpOnly, so the UI
// learns "who am I" (and with what role) from /api/me once per load; the roster
// (/api/users) feeds rep↔venue matching and the transcription glossary.

interface RepValue {
  /** Signed-in identity — the EFFECTIVE account (a developer impersonating a
   * rep shows up as that rep). Null while loading or if the session expired. */
  me: { id: string; name: string } | null;
  /** Effective role: drives every per-page scoping decision. */
  role: Role;
  /** True for admins/developers — they see company-wide data. */
  seesEverything: boolean;
  /** True for the isolated developer test account (writes stay in the browser). */
  sandbox: boolean;
  /** The real developer behind an impersonated session (for the banner), else null. */
  realName: string | null;
  /** Full team roster (public shape — no password material). Falls back to the
   * fixed team list before the roster has been seeded, so matching still works. */
  reps: Rep[];
  /** Just the sales reps, for the admin/developer calendar + activity switcher. */
  salesReps: Rep[];
  loading: boolean;
  refreshRoster: () => void;
  /** Which rep an admin/developer is currently looking at on the calendar and
   * activity pages (they have no data of their own). Reps ignore this. */
  viewRepId: string | null;
  setViewRepId: (id: string) => void;
}

const RepContext = createContext<RepValue | null>(null);

const TEAM_AS_REPS: Rep[] = TEAM_ACCOUNTS.map((a) => ({
  id: a.id,
  name: a.name,
  aliases: a.aliases,
  role: a.role,
}));

export function RepProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [role, setRole] = useState<Role>("rep");
  const [sandbox, setSandbox] = useState(false);
  const [realName, setRealName] = useState<string | null>(null);
  const [reps, setReps] = useState<Rep[]>(TEAM_AS_REPS);
  const [loading, setLoading] = useState(true);
  const [viewRepId, setViewRepIdRaw] = useState<string | null>(null);

  const setViewRepId = useCallback((id: string) => {
    setViewRepIdRaw(id);
    try { localStorage.setItem("ltp_view_rep", id); } catch { /* ignore */ }
  }, []);

  const refreshRoster = useCallback(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d: { users?: PublicRep[] }) => {
        // Use the seeded roster once it exists (it carries any admin-tuned
        // aliases); otherwise keep the fixed team list so matching still works.
        if (Array.isArray(d.users) && d.users.length) {
          setReps(d.users.map((u) => ({ id: u.id, name: u.name, aliases: u.aliases, role: u.role })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const saved = localStorage.getItem("ltp_view_rep");
      if (saved) setViewRepIdRaw(saved);
    } catch { /* ignore */ }
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { id?: string; name?: string; role?: Role; sandbox?: boolean; realName?: string } | null) => {
        if (cancelled || !d?.id || !d?.name) return;
        setMe({ id: d.id, name: d.name });
        setRole(d.role === "admin" || d.role === "developer" ? d.role : "rep");
        setSandbox(Boolean(d.sandbox));
        setRealName(d.realName ?? null);
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

  const salesReps = useMemo(() => reps.filter((r) => (r.role ?? "rep") === "rep"), [reps]);

  const value = useMemo(
    () => ({
      me,
      role,
      seesEverything: seesEverything(role),
      sandbox,
      realName,
      reps,
      salesReps,
      loading,
      refreshRoster,
      viewRepId,
      setViewRepId,
    }),
    [me, role, sandbox, realName, reps, salesReps, loading, refreshRoster, viewRepId, setViewRepId],
  );
  return <RepContext.Provider value={value}>{children}</RepContext.Provider>;
}

export function useRep(): RepValue {
  const ctx = useContext(RepContext);
  if (!ctx) throw new Error("useRep must be used within RepProvider");
  return ctx;
}
