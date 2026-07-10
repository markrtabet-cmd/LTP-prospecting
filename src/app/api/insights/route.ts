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
    return NextResponse.json(await fetchSalesInsights(scope));
  } catch (e) {
    return NextResponse.json({ configured: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
