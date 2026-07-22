// Server-only Google Places (New) enrichment for scanned openings.
//
// The web scan only ever captures a venue's name/area and the *source article*
// URL — never the restaurant's own website or phone. This backfills those from
// the Places `searchText` endpoint, but ONLY for London venues, to keep the
// paid Contact-data calls (~$40/1000) bounded. Everything here is best-effort:
// a missing key, a timeout, or no match just leaves the opening un-enriched
// (its Website row stays "—"), never failing the scan.

import { areaToBorough, geocodeArea, type ScannedOpening } from "./openings";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
// id/displayName are Basic data; nationalPhoneNumber + websiteUri are Contact
// data (the billable-at-~$40/1000 fields we actually want here).
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
].join(",");

// Cost/latency ceilings — the manual route has a 60s budget shared with the
// (slow) web-search scan, so enrichment must stay well-bounded.
const MAX_ENRICH = 15; // most venues to look up per scan
const CONCURRENCY = 5; // parallel Places calls
const CALL_TIMEOUT_MS = 4000; // per-call abort
const TOTAL_BUDGET_MS = 12000; // overall stop-and-return deadline

// London-confidence gate: enrich only when we're sure the venue is in London,
// so a UK-wide scan never spends a Places call (or mis-attaches a same-name
// London site) on an out-of-town opening. City explicitly London, or an area
// that maps to a known London borough.
function isConfidentLondon(o: ScannedOpening): boolean {
  const city = (o.city || "").toLowerCase();
  if (city && city.includes("london")) return true;
  if (city && !city.includes("london")) return false; // a named non-London city wins
  return o.area ? areaToBorough(o.area) !== null : false;
}

function namesSimilar(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One name fully contains the other, and the shorter is substantial enough
  // that the overlap is meaningful. The old 5-char-PREFIX test was far too loose
  // — "theivory" vs "theivy" shared "theiv", so Google's "The Ivy" was accepted
  // for a scanned "The Ivory" and its website/phone mis-attached.
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 5 && long.includes(short);
}

interface PlacesEnrichment {
  website?: string;
  phone?: string;
  businessStatus?: string;
  googlePlaceId?: string;
}

// Field mask for the Add-prospect smart-match: as FIELD_MASK, plus the address +
// exact location so we can suggest a street address and drop the pin precisely.
const LOOKUP_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
].join(",");

export interface PlaceMatch {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  website?: string;
  googlePlaceId?: string;
  businessStatus?: string;
}

/**
 * One-shot Google Places lookup for the phone "Add prospect" smart-match: given
 * a venue name and (optionally) a postcode, return the best-matching real place
 * with its street address + exact location, so the rep can accept a suggested
 * address instead of typing everything. The place need NOT already be a lead.
 *
 * Best-effort and never throws: no API key, a timeout, no result, or a name that
 * doesn't line up with what Google returned all yield null (the flow then falls
 * back to postcode-only). The name guard (namesSimilar) is what stops a wrong
 * venue's address/phone being suggested.
 */
export async function lookupPlace(
  name: string,
  postcode: string,
  biasLat: number,
  biasLng: number,
): Promise<PlaceMatch | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || name.trim().length < 2) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": LOOKUP_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `${name} ${postcode}`.trim(),
        regionCode: "GB",
        // Tight bias around the postcode centroid — we want THIS venue, not a
        // same-name branch across town.
        locationBias: { circle: { center: { latitude: biasLat, longitude: biasLng }, radius: 3000 } },
        maxResultCount: 1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      places?: {
        id?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        nationalPhoneNumber?: string;
        websiteUri?: string;
        businessStatus?: string;
      }[];
    };
    const place = data.places?.[0];
    if (!place) return null;
    if (!namesSimilar(name, place.displayName?.text ?? "")) return null;
    return {
      name: place.displayName?.text ?? name,
      address: place.formattedAddress ?? undefined,
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      phone: place.nationalPhoneNumber ?? undefined,
      website: place.websiteUri ?? undefined,
      googlePlaceId: place.id ?? undefined,
      businessStatus: place.businessStatus ?? undefined,
    };
  } catch {
    return null; // timeout / network / parse — non-fatal
  } finally {
    clearTimeout(timer);
  }
}

async function searchPlace(
  apiKey: string,
  name: string,
  query: string,
  lat: number,
  lng: number
): Promise<PlacesEnrichment | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        regionCode: "GB",
        locationBias: {
          // Wide bias — our geocode is only an area centroid, so keep the whole
          // of London in range rather than a tight circle that could miss it.
          circle: { center: { latitude: lat, longitude: lng }, radius: 10000 },
        },
        maxResultCount: 1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      places?: {
        id?: string;
        displayName?: { text?: string };
        nationalPhoneNumber?: string;
        websiteUri?: string;
        businessStatus?: string;
      }[];
    };
    const place = data.places?.[0];
    if (!place) return null;
    // Reject a wrong match — the name has to line up with what Google returned.
    if (!namesSimilar(name, place.displayName?.text ?? "")) return null;
    return {
      website: place.websiteUri ?? undefined,
      phone: place.nationalPhoneNumber ?? undefined,
      businessStatus: place.businessStatus ?? undefined,
      googlePlaceId: place.id ?? undefined,
    };
  } catch {
    return null; // timeout / network / parse — non-fatal
  } finally {
    clearTimeout(timer);
  }
}

// Backfill website/phone for London openings via Google Places. Returns a new
// array; non-London, already-known, or unmatched openings pass through
// unchanged. Never throws.
export async function enrichOpeningsWithPlaces(
  openings: ScannedOpening[]
): Promise<ScannedOpening[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return openings;

  // Choose the London venues that still need a website, capped for cost.
  const targets: { idx: number; name: string; query: string; lat: number; lng: number }[] = [];
  for (let idx = 0; idx < openings.length; idx++) {
    if (targets.length >= MAX_ENRICH) break;
    const o = openings[idx];
    const name = (o?.name || "").trim();
    if (!name || o.website) continue; // nothing to look up / already have a site
    if (!isConfidentLondon(o)) continue; // London only — cost control
    const geo = geocodeArea(o.area, o.city);
    const where = [o.area, "London"].filter(Boolean).join(", ");
    targets.push({ idx, name, query: `${name} ${where}`, lat: geo.lat, lng: geo.lng });
  }
  if (!targets.length) return openings;

  const out = openings.slice();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length && Date.now() < deadline) {
      const t = targets[cursor++];
      const found = await searchPlace(apiKey, t.name, t.query, t.lat, t.lng);
      if (found) out[t.idx] = { ...out[t.idx], ...found };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)
  );
  return out;
}
