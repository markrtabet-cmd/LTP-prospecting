"use client";

import { useEffect, useState } from "react";
import { useRep } from "./rep";
import type { PublicRep } from "./users";

// Per-rep email signature, auto-appended when a draft is handed to the rep's
// mail client (Email centre + RecordMeetingSheet mailto links). Stored on the
// Rep record in ltp_users (edited on Settings), exposed via /api/users'
// PublicRep shape; falls back to localStorage before Supabase is set up, then
// to a minimal "Best, <first name>" sign-off.

export function signatureLocalKey(repId: string): string {
  return `ltp_email_signature:${repId}`;
}

/** "Best,\nNick\nLa Tua Pasta" — used until the rep saves a real signature. */
export function defaultSignature(name?: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Best,\n${first}\nLa Tua Pasta` : `Best,\nLa Tua Pasta`;
}

// Trailing opt-out line ("— Reply STOP to unsubscribe." / "Reply STOP to opt
// out.") — the signature slots in ABOVE it so the compliance line stays last.
const OPT_OUT_RE = /\n+\s*(?:—\s*)?Reply STOP[^\n]*\s*$/i;

// Sign-off placeholders older saved drafts may still carry (the pre-signature
// default template and AI prompt both wrote these) — replaced in-place by the
// real signature rather than doubling up.
const LEGACY_SIGNOFF_RE = /Best,\n\[(?:Your name|Salesperson Name)\]\nLa Tua Pasta/;

// A dangling AI/legacy sign-off ("Best," / "Kind regards," … as the last line)
// left when a body was generated before the no-sign-off prompt rules, or when
// the model ignores them — stripped so the appended signature doesn't double up.
const TRAILING_SIGNOFF_RE = /\n+\s*(?:best|best regards|kind regards|warm regards|regards|thanks|many thanks)\s*,?\s*$/i;

/** Append the signature to an email body unless it's already there. */
export function appendSignature(body: string, signature: string): string {
  const sig = signature.trim();
  if (!sig || body.includes(sig)) return body;
  if (LEGACY_SIGNOFF_RE.test(body)) return body.replace(LEGACY_SIGNOFF_RE, sig);
  const optOut = body.match(OPT_OUT_RE);
  if (optOut) {
    const head = body.slice(0, body.length - optOut[0].length).replace(TRAILING_SIGNOFF_RE, "").trimEnd();
    return `${head}\n\n${sig}\n\n${optOut[0].trim()}`;
  }
  return `${body.replace(TRAILING_SIGNOFF_RE, "").trimEnd()}\n\n${sig}`;
}

/** The signed-in rep's signature: saved value if any, else the default. */
export function useEmailSignature(): string {
  const { me } = useRep();
  const meId = me?.id ?? null;
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    // Local copy first so the value is instant (and works pre-Supabase)…
    try {
      const local = localStorage.getItem(signatureLocalKey(meId));
      if (local) setSaved(local);
    } catch {
      // ignore
    }
    // …then the roster's authoritative copy.
    fetch("/api/users")
      .then((r) => r.json())
      .then((d: { users?: PublicRep[] }) => {
        if (cancelled) return;
        const mine = d.users?.find((u) => u.id === meId);
        if (mine?.signature) setSaved(mine.signature);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meId]);

  return saved?.trim() ? saved : defaultSignature(me?.name);
}
