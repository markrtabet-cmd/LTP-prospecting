import { NextResponse } from "next/server";
import { getDatasetLastRefreshTime } from "@/lib/powerbi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// When the Power BI dataset last completed a refresh — surfaced as the "Power BI
// updated X ago" badge in the top bar. Cached 30 min in-memory by the helper.
export async function GET() {
  try {
    const refreshedAt = await getDatasetLastRefreshTime();
    return NextResponse.json({ refreshedAt });
  } catch {
    return NextResponse.json({ refreshedAt: null });
  }
}
