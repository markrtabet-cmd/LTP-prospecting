import { NextResponse } from "next/server";
import { fetchDashboardKpis, type Scope } from "@/lib/sales-analytics";

// Dashboard sales KPIs, scoped to a set of customer account codes (a rep's book)
// or company-wide (codes: null). Session-gated by the middleware.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const scope: Scope = Array.isArray(body?.codes) ? (body.codes as string[]) : null;
    return NextResponse.json(await fetchDashboardKpis(scope));
  } catch (e) {
    return NextResponse.json({ configured: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
