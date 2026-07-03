import { NextResponse } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import type { Meeting } from "@/lib/types";

// Calendar meetings (scheduled / completed / missed / cancelled), one row per
// meeting in ltp_meetings (id text pk, data jsonb). Session-gated by
// middleware. Falls back to {configured:false} so the client keeps meetings in
// localStorage when Supabase (or the table) isn't set up yet — same pattern as
// /api/data.

export const runtime = "nodejs";

const TABLE = "ltp_meetings";

// PostgREST errors are plain objects, not Error instances.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "unknown error";
}

async function selectAll(): Promise<Meeting[]> {
  const sb = supabaseAdmin();
  const out: Meeting[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(TABLE).select("id,data").range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data ?? []) out.push(row.data as Meeting);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ configured: false });
  try {
    const meetings = await selectAll();
    return NextResponse.json({ configured: true, meetings });
  } catch (e) {
    const message = errMessage(e);
    // Table probably not created yet — tell the client to run local-only so
    // the calendar still works before the SQL has been pasted in.
    if (/relation .* does not exist|could not find the table|schema cache/i.test(message)) {
      return NextResponse.json({ configured: false, needsTable: true });
    }
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, configured: false });
  let body: {
    op?: string;
    items?: Meeting[];
    patches?: Record<string, Partial<Meeting>>;
    id?: string;
    repId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const sb = supabaseAdmin();

    if (body.op === "upsertMany" && body.items?.length) {
      const rows = body.items.map((m) => ({ id: m.id, data: m }));
      const { error } = await sb.from(TABLE).upsert(rows, { onConflict: "id" });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (body.op === "updateMany" && body.patches) {
      const ids = Object.keys(body.patches);
      if (!ids.length) return NextResponse.json({ ok: true });
      const { data, error } = await sb.from(TABLE).select("id,data").in("id", ids);
      if (error) throw error;
      const existing = new Map((data ?? []).map((r) => [r.id as string, r.data as Meeting]));
      const rows: { id: string; data: Meeting }[] = [];
      for (const id of ids) {
        const cur = existing.get(id);
        if (!cur) continue; // vanished — nothing to patch
        rows.push({ id, data: { ...cur, ...body.patches[id], updatedAt: new Date().toISOString() } });
      }
      if (rows.length) {
        const up = await sb.from(TABLE).upsert(rows, { onConflict: "id" });
        if (up.error) throw up.error;
      }
      return NextResponse.json({ ok: true });
    }

    if (body.op === "remove" && body.id) {
      const { error } = await sb.from(TABLE).delete().eq("id", body.id);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    // Auto-scheduler re-flow: atomically replace a rep's fluid (unlocked,
    // scheduler-created, still-scheduled) meetings with the new plan. Locked,
    // completed and missed rows are never touched here.
    if (body.op === "replaceScheduled" && body.repId) {
      const all = await selectAll();
      const stale = all.filter(
        (m) =>
          m.repId === body.repId &&
          m.source === "scheduler" &&
          m.status === "scheduled" &&
          !m.locked,
      );
      const keep = new Set((body.items ?? []).map((m) => m.id));
      const toDelete = stale.filter((m) => !keep.has(m.id)).map((m) => m.id);
      if (toDelete.length) {
        const del = await sb.from(TABLE).delete().in("id", toDelete);
        if (del.error) throw del.error;
      }
      if (body.items?.length) {
        const rows = body.items.map((m) => ({ id: m.id, data: m }));
        const up = await sb.from(TABLE).upsert(rows, { onConflict: "id" });
        if (up.error) throw up.error;
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errMessage(e) }, { status: 500 });
  }
}
