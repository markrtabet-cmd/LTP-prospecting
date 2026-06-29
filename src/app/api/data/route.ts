import { NextResponse } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";

// Shared team data: manually-added venues + per-venue overrides, stored in
// Supabase so everyone with the password sees the same pipeline. Gated by the
// session cookie via middleware. Falls back to {configured:false} so the client
// uses localStorage when Supabase isn't set up yet.

export const runtime = "nodejs";

const ADDED = "ltp_added";
const OVERRIDES = "ltp_overrides";

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ configured: false });
  try {
    const sb = supabaseAdmin();
    const [addedRes, ovRes] = await Promise.all([
      sb.from(ADDED).select("id,data"),
      sb.from(OVERRIDES).select("id,patch"),
    ]);
    if (addedRes.error) throw addedRes.error;
    if (ovRes.error) throw ovRes.error;
    const added = (addedRes.data ?? []).map((r) => r.data as Restaurant);
    const overrides: Record<string, Partial<Restaurant>> = {};
    for (const r of ovRes.data ?? []) overrides[r.id as string] = r.patch as Partial<Restaurant>;
    return NextResponse.json({ configured: true, added, overrides });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, configured: false });
  let body: {
    op?: string;
    items?: Restaurant[];
    patches?: Record<string, Partial<Restaurant>>;
    id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const sb = supabaseAdmin();

    if (body.op === "addMany" && body.items?.length) {
      const rows = body.items.map((it) => ({ id: it.id, data: it }));
      const { error } = await sb.from(ADDED).upsert(rows, { onConflict: "id" });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (body.op === "updateMany" && body.patches) {
      const ids = Object.keys(body.patches);
      if (!ids.length) return NextResponse.json({ ok: true });
      // Merge against existing rows so partial patches accumulate.
      const [addedRes, ovRes] = await Promise.all([
        sb.from(ADDED).select("id,data").in("id", ids),
        sb.from(OVERRIDES).select("id,patch").in("id", ids),
      ]);
      if (addedRes.error) throw addedRes.error;
      if (ovRes.error) throw ovRes.error;
      const addedMap = new Map((addedRes.data ?? []).map((r) => [r.id as string, r.data as Restaurant]));
      const ovMap = new Map((ovRes.data ?? []).map((r) => [r.id as string, r.patch as Partial<Restaurant>]));

      const addedUpserts: { id: string; data: Restaurant }[] = [];
      const ovUpserts: { id: string; patch: Partial<Restaurant> }[] = [];
      for (const id of ids) {
        const patch = body.patches[id];
        if (addedMap.has(id)) {
          addedUpserts.push({ id, data: { ...(addedMap.get(id) as Restaurant), ...patch } });
        } else {
          ovUpserts.push({ id, patch: { ...(ovMap.get(id) ?? {}), ...patch } });
        }
      }
      const ops = [];
      if (addedUpserts.length) ops.push(sb.from(ADDED).upsert(addedUpserts, { onConflict: "id" }));
      if (ovUpserts.length) ops.push(sb.from(OVERRIDES).upsert(ovUpserts, { onConflict: "id" }));
      const results = await Promise.all(ops);
      for (const r of results) if (r.error) throw r.error;
      return NextResponse.json({ ok: true });
    }

    if (body.op === "remove" && body.id) {
      const [a, o] = await Promise.all([
        sb.from(ADDED).delete().eq("id", body.id),
        sb.from(OVERRIDES).delete().eq("id", body.id),
      ]);
      if (a.error) throw a.error;
      if (o.error) throw o.error;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
