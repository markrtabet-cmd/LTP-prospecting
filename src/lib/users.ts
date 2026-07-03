// Server-side access to the sales-team roster (ltp_users: id text pk, data
// jsonb). Same graceful pattern as the rest of the app: when Supabase isn't
// configured — or the table hasn't been created yet — everything degrades to
// an empty roster and login falls back to the shared SITE_PASSWORD, so the
// app keeps working before the SQL has been run.

import { isSupabaseConfigured, supabaseAdmin } from "./supabase";
import type { Rep } from "./types";

const TABLE = "ltp_users";

export async function listReps(): Promise<Rep[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const { data, error } = await supabaseAdmin().from(TABLE).select("id,data");
    if (error) return [];
    return (data ?? []).map((r) => r.data as Rep).filter((r) => r && r.id && r.name);
  } catch {
    return [];
  }
}

export async function getRep(id: string): Promise<Rep | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabaseAdmin().from(TABLE).select("data").eq("id", id).maybeSingle();
    if (error || !data) return null;
    return data.data as Rep;
  } catch {
    return null;
  }
}

export async function upsertRep(rep: Rep): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "not_configured" };
  const { error } = await supabaseAdmin()
    .from(TABLE)
    .upsert({ id: rep.id, data: rep }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function removeRep(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "not_configured" };
  const { error } = await supabaseAdmin().from(TABLE).delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Roster shape safe to send to the browser (no password material). */
export interface PublicRep {
  id: string;
  name: string;
  aliases: string[];
  hasPassword: boolean;
}

export function toPublicRep(rep: Rep): PublicRep {
  return {
    id: rep.id,
    name: rep.name,
    aliases: rep.aliases ?? [],
    hasPassword: Boolean(rep.passwordHash && rep.passwordSalt),
  };
}
