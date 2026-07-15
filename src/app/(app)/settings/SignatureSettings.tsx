"use client";

import { useEffect, useState } from "react";
import { useRep } from "@/lib/rep";
import { defaultSignature, signatureLocalKey } from "@/lib/signature";
import type { PublicRep } from "@/lib/users";

// Per-rep email signature editor. Saved on the rep's own ltp_users record via
// /api/users {op:"setSignature"} (the server derives WHO from the session —
// you can only ever edit your own). Falls back to localStorage when Supabase
// isn't configured (or on the sandbox account) so the feature still works.
// The signature is auto-appended when a draft opens in the mail client — see
// src/lib/signature.ts.
export function SignatureSettings() {
  const { me } = useRep();
  const meId = me?.id ?? null;
  const [signature, setSignature] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    try {
      const local = localStorage.getItem(signatureLocalKey(meId));
      if (local) setSignature(local);
    } catch {
      // ignore
    }
    fetch("/api/users")
      .then((r) => r.json())
      .then((d: { users?: PublicRep[] }) => {
        if (cancelled) return;
        const mine = d.users?.find((u) => u.id === meId);
        if (mine?.signature) setSignature(mine.signature);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [meId]);

  async function save() {
    if (!meId) return;
    setBusy(true);
    setMessage("");
    let persisted = false;
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "setSignature", signature }),
      });
      const d: { ok?: boolean } = await res.json().catch(() => ({}));
      persisted = Boolean(d.ok);
    } catch {
      // fall through to the local copy
    }
    // Keep a local copy either way — it doubles as the offline/unconfigured store.
    try {
      if (signature.trim()) localStorage.setItem(signatureLocalKey(meId), signature);
      else localStorage.removeItem(signatureLocalKey(meId));
    } catch {
      // ignore
    }
    setMessage(persisted ? "Saved ✓" : "Saved on this device ✓");
    setBusy(false);
  }

  return (
    <div>
      <p className="mb-2 text-xs text-slate-400">
        Added automatically to the bottom of every email you open in your email app (outreach drafts and
        meeting follow-ups). Leave empty to use the default below.
      </p>
      <textarea
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        rows={4}
        placeholder={defaultSignature(me?.name)}
        disabled={!loaded}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !meId}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save signature"}
        </button>
        {message && <span className="text-xs text-slate-400">{message}</span>}
      </div>
    </div>
  );
}
