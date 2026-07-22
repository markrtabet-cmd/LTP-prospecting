import { NextResponse } from "next/server";
import { fetchSalesInsights, type Scope } from "@/lib/sales-analytics";

// Sales + Product insights, scoped to a rep's account codes or company-wide
// (codes: null). Deterministic Power BI aggregations. Session-gated by middleware.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const scope: Scope = Array.isArray(body?.codes) ? (body.codes as string[]) : null;
    // The viewed rep's display name — scopes the samples list by F_DAILY[Sales
    // Rep] so samples booked on the rep's prospect pseudo-account are included.
    const repName = typeof body?.repName === "string" && body.repName.trim() ? (body.repName as string).trim() : null;
    // The dashboard sends the handful of metrics it actually shows (attention +
    // its two tiles) so only those Power BI queries run; the full Insights page
    // omits this and computes everything.
    const metrics = Array.isArray(body?.metrics)
      ? (body.metrics as unknown[]).filter((m): m is string => typeof m === "string")
      : undefined;
    return NextResponse.json(await fetchSalesInsights(scope, { repName, metrics }));
  } catch (e) {
    return NextResponse.json({ configured: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
