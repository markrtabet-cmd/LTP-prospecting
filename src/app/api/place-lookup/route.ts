import { NextResponse } from "next/server";
import { canonicalPostcode, geocodePostcodes } from "@/lib/geocode";
import { lookupPlace } from "@/lib/places";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin helper for the phone "Add prospect" flow.
//
// Two jobs, both best-effort (this route always 200s, with nulls on failure, so
// the client can never break on it):
//  1. Geocode a postcode server-side via postcodes.io. Doing it here rather than
//     with a client cross-origin fetch means it can't be ad-blocked / proxy-
//     blocked on a phone — that silent failure was dropping manually-entered
//     venues at the borough centroid instead of their postcode.
//  2. When a name is supplied, try a Google Places match to suggest a street
//     address + exact building location (needs GOOGLE_PLACES_API_KEY; absent →
//     place: null, and the flow degrades gracefully to postcode-only).
//
// Session-gated by src/middleware.ts (not public, not a cron path), so the
// Google key stays server-side and only signed-in reps can call it.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const postcode = (searchParams.get("postcode") || "").trim();
    const name = (searchParams.get("name") || "").trim();

    const geo = postcode
      ? (await geocodePostcodes([postcode])).get(canonicalPostcode(postcode)) ?? null
      : null;

    // Bias the Places search to the postcode centroid when we have it, else
    // central London (keeps a same-name venue elsewhere from winning).
    const biasLat = geo?.latitude ?? 51.5074;
    const biasLng = geo?.longitude ?? -0.1278;
    const place = name.length >= 2 ? await lookupPlace(name, postcode, biasLat, biasLng) : null;

    return NextResponse.json({
      postcode: geo
        ? { lat: geo.latitude, lng: geo.longitude, district: geo.district ?? null, approximate: !!geo.approximate }
        : null,
      place,
    });
  } catch {
    return NextResponse.json({ postcode: null, place: null });
  }
}
