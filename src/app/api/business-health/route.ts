import { NextResponse } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { BUSINESS_HEALTH_TABLE, BUSINESS_HEALTH_ROW_ID, type BusinessHealthResult } from "@/lib/business-health-compute";

// Serves the cached weekly business-health digest to the Dashboard. Recompute
// happens on a separate path (see ./recompute/route.ts) so Vercel Cron's
// GET-only trigger doesn't collide with this read.

export const runtime = "nodejs";

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "unknown error";
}

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ configured: false });
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from(BUSINESS_HEALTH_TABLE).select("data").eq("id", BUSINESS_HEALTH_ROW_ID).maybeSingle();
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
