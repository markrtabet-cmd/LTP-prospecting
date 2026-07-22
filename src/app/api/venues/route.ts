import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { loadFullBaseVenues } from "@/lib/base-dataset";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import type { RawVenue } from "@/lib/mock-data";

// The base venue dataset for the client.
//
// The full UK dataset is ~43MB / 134k venues; shipping and parsing all of it on
// every phone/laptop was the single biggest cause of slowness. This route does
// the heavy lifting ONCE, server-side (and caches it): it loads the full
// dataset, keeps only PROSPECTS within 60 miles of central London — which is all
// the map/leads ever show — and returns a compact payload (~15MB, ~2.6MB
// gzipped over the wire, vs 43MB before). CUSTOMERS are always kept regardless
// of distance so no account is ever hidden: seed-list customers and any venue an
// override touches (a manually linked / edited customer) are exempt from the
// radius filter. Session-gated by middleware like the rest of the app.

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // we set our own Cache-Control below

const CENTRE: [number, number] = [51.5074, -0.1278];
const RADIUS_KM = 60 * 1.60934; // 60 miles

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Ids to keep regardless of distance (customers must never be hidden). Best
// effort — any failure just falls back to the pure radius filter, which already
// covers every customer within 60mi (i.e. LTP's whole book).
async function customerKeepIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const seedPath = path.join(process.cwd(), "public", "seed-customers.json");
    const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as { ids?: string[] };
    for (const id of seed.ids ?? []) ids.add(id);
  } catch {
    /* seed optional */
  }
  try {
    if (isSupabaseConfigured()) {
      const sb = supabaseAdmin();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("ltp_overrides").select("id").range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) ids.add(r.id as string);
        if (!data || data.length < 1000) break;
      }
    }
  } catch {
    /* overrides optional */
  }
  return ids;
}

// Module-scoped cache of the built payload (raw JSON + gzipped) so back-to-back
// requests on a warm instance don't re-filter 134k rows or re-compress. The edge
// cache (Cache-Control below) means the function itself runs rarely.
let payloadCache: { at: number; body: string; gz: Buffer } | null = null;
const PAYLOAD_TTL_MS = 10 * 60 * 1000;

// Edge-cache for a day; serve stale while revalidating for a week. The dataset
// only changes on the daily refresh.
const CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

async function buildPayload(): Promise<{ body: string; gz: Buffer }> {
  if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_TTL_MS) {
    return { body: payloadCache.body, gz: payloadCache.gz };
  }
  const [all, keep] = await Promise.all([loadFullBaseVenues(), customerKeepIds()]);
  const filtered = all.filter((v: RawVenue) => {
    if (keep.has(v.id)) return true;
    if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return true;
    return haversineKm(CENTRE, [v.latitude, v.longitude]) <= RADIUS_KM;
  });
  const body = JSON.stringify({ venues: filtered });
  const gz = zlib.gzipSync(body);
  payloadCache = { at: Date.now(), body, gz };
  return { body, gz };
}

export async function GET(req: Request) {
  try {
    const { body, gz } = await buildPayload();
    // Gzip the ~15MB payload down to ~2.6MB. Returning it pre-compressed (a) keeps
    // the serverless response body well under platform output limits and (b) is
    // decompressed transparently by the browser. Fall back to raw JSON for the
    // rare client that doesn't accept gzip.
    const acceptsGzip = (req.headers.get("accept-encoding") || "").includes("gzip");
    if (acceptsGzip) {
      return new NextResponse(gz as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Vary": "Accept-Encoding",
          "Cache-Control": CACHE_CONTROL,
        },
      });
    }
    return new NextResponse(body, {
      headers: { "Content-Type": "application/json", "Vary": "Accept-Encoding", "Cache-Control": CACHE_CONTROL },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ venues: [], error: message }, { status: 500 });
  }
}
