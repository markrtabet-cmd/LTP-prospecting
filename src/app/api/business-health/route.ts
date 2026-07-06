import { NextResponse } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { BUSINESS_HEALTH_TABLE, BUSINESS_HEALTH_ROW_ID, type BusinessHealthResult } from "@/lib/business-health-compute";

// Serves the cached weekly business-health digest to the Dashboard. Recompute
// happens on a separate path (see ./recompute/route.ts) so Vercel Cron's
// GET-only trigger doesn't collide with this read.

export const runtime = "nodejs";
// Without this, a GET handler with no dynamic request APIs is eligible for
// Next.js's automatic static caching — meaning the very first response
// (likely "computed: false", before the weekly recompute has ever run)
// could get cached and keep being served even after real data lands.
export const dynamic = "force-dynamic";

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "unknown error";
}

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ configured: false });
  try {
    const sb = supabaseAdmin();
    // NOTE: .select("data") alone (a single bare column name) mysteriously
    // returns zero rows against this Supabase client version, even though the
    // row demonstrably exists (confirmed directly against PostgREST) — same
    // symptom with or without .maybeSingle(). Selecting id+data together
    // works correctly, so that's the query shape used here.
    const { data, error } = await sb.from(BUSINESS_HEALTH_TABLE).select("id,data").eq("id", BUSINESS_HEALTH_ROW_ID).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ configured: true, computed: false });
    return NextResponse.json({ configured: true, computed: true, ...(data.data as BusinessHealthResult) });
  } catch (e) {
    const message = errMessage(e);
    if (/relation .* does not exist|could not find the table|schema cache/i.test(message)) {
      return NextResponse.json({ configured: false, needsTable: true });
    }
    return NextResponse.json({ configured: false, error: message }, { status: 500 });
  }
}
