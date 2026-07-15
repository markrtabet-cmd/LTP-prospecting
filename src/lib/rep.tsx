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
  /** Which rep an admin/developer is currently looking at, site-wide (null/""
   * = "Whole company" overview). Reps ignore this. Persisted per browser. */
  viewRepId: string | null;
  setViewRepId: (id: string) => void;
  /** The single rep ALL data on the page should scope to: a plain rep = self;
   * an admin/dev = the rep they picked in the switcher, or null for the whole
   * company. Read-only scoping — it never changes who writes are attributed to. */
  subjectRep: Rep | null;
  /** True when the page should show one rep's data (a plain rep, or an admin who
   * picked a rep); false = company-wide overview. */
  scopedToRep: boolean;
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

  const canSeeEverything = seesEverything(role);
  // The single rep every page scopes to. A plain rep is always themselves; an
  // admin/dev follows the site-wide switcher (a picked rep, or null = company).
  const subjectRep = useMemo<Rep | null>(() => {
    if (!canSeeEverything) {
      return me ? reps.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null;
    }
    if (!viewRepId) return null; // "Whole company" overview
    return salesReps.find((r) => r.id === viewRepId) ?? null;
  }, [canSeeEverything, me, reps, salesReps, viewRepId]);
  const scopedToRep = !canSeeEverything || subjectRep !== null;

  const value = useMemo(
    () => ({
      me,
      role,
      seesEverything: canSeeEverything,
      sandbox,
      realName,
      reps,
      salesReps,
      loading,
      refreshRoster,
      viewRepId,
      setViewRepId,
      subjectRep,
      scopedToRep,
    }),
    [me, role, canSeeEverything, sandbox, realName, reps, salesReps, loading, refreshRoster, viewRepId, setViewRepId, subjectRep, scopedToRep],
  );
  return <RepContext.Provider value={value}>{children}</RepContext.Provider>;
}

export function useRep(): RepValue {
  const ctx = useContext(RepContext);
  if (!ctx) throw new Error("useRep must be used within RepProvider");
  return ctx;
}
