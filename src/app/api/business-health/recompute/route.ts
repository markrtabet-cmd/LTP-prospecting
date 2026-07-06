import { NextResponse } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { isPowerBIConfigured } from "@/lib/powerbi";
import { computeBusinessHealth, BUSINESS_HEALTH_TABLE, BUSINESS_HEALTH_ROW_ID } from "@/lib/business-health-compute";

// Weekly recompute of the Dashboard's AI business-health digest. Invoked by
// Vercel Cron (see vercel.json) — same CRON_SECRET pattern as
// /api/sync-customers. Pulls several bulk aggregates from Power BI (a few
// thousand rows each, not the raw fact table) then one Claude call to write
// up the two summaries, so this can take a while — generous timeout.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "unknown error";
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isPowerBIConfigured()) return NextResponse.json({ ok: false, error: "Power BI not configured" });
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, error: "Supabase not configured" });

  try {
    const result = await computeBusinessHealth();
    const sb = supabaseAdmin();
    const { error } = await sb
      .from(BUSINESS_HEALTH_TABLE)
      .upsert({ id: BUSINESS_HEALTH_ROW_ID, data: result, computed_at: result.computedAt }, { onConflict: "id" });
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      computedAt: result.computedAt,
      anomalyCount: result.anomalies.length,
      opportunityCount: result.opportunities.length,
    });
  } catch (e) {
    const message = errMessage(e);
    console.error("[business-health-recompute] failed:", message);
    if (/relation .* does not exist|could not find the table|schema cache/i.test(message)) {
      return NextResponse.json({ ok: false, needsTable: true, error: message });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle; // Vercel Cron issues GET
export const POST = handle; // allow manual trigger via curl
