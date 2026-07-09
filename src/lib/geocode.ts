// Server-only postcode geocoder using postcodes.io — the same free, keyless UK
// postcode-centroid API the FSA refresh script uses to backfill venues that FSA
// left without coordinates (see scripts/fetch-fsa.mjs). Its bulk endpoint takes
// up to 100 postcodes per request and returns each postcode's centroid lat/lng
// plus its admin district (borough), which is precise enough for prospecting —
// a UK postcode typically covers a single street/block.

const BULK_URL = "https://api.postcodes.io/postcodes";
const BATCH_SIZE = 100; // postcodes.io bulk lookup max per request
const CONCURRENCY = 5;

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  /** Local authority district, e.g. "Westminster" — used as a borough guess. */
  district?: string;
}

/** Normalise to the canonical spaced form postcodes.io echoes back (e.g. "SW1A 1AA"). */
export function canonicalPostcode(pc: string): string {
  return (pc || "").toUpperCase().replace(/\s+/g, " ").trim();
}
const canonical = canonicalPostcode;

/** The outward code (postcode district), e.g. "SW1A 1AA" → "SW1A". */
export function outwardCode(pc: string): string {
  const c = (pc || "").toUpperCase().replace(/\s+/g, "");
  if (c.length < 4) return c;
  // Inward code is always the last 3 chars (digit + two letters); the rest is
  // the outward code.
  return c.slice(0, c.length - 3);
}

async function runPool<T>(items: T[], fn: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function lookupBatch(postcodes: string[]): Promise<{ query: string; result: Record<string, unknown> | null }[]> {
  try {
    const res = await fetch(BULK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { result?: { query: string; result: Record<string, unknown> | null }[] };
    return data.result ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve many postcodes to centroids in one pass. Returns a Map keyed by the
 * canonical spaced postcode; postcodes that are blank or unrecognised are
 * simply absent from the map (the caller decides what to do with them). Never
 * throws — a postcodes.io outage yields an empty map, not a failed sync.
 */
export async function geocodePostcodes(rawPostcodes: string[]): Promise<Map<string, GeocodeResult>> {
  const unique = Array.from(new Set(rawPostcodes.map(canonical).filter(Boolean)));
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) batches.push(unique.slice(i, i + BATCH_SIZE));

  const out = new Map<string, GeocodeResult>();
  await runPool(
    batches,
    async (batch) => {
      const results = await lookupBatch(batch);
      for (const r of results) {
        const res = r.result;
        const lat = res?.["latitude"];
        const lng = res?.["longitude"];
        if (typeof lat === "number" && typeof lng === "number") {
          const district = res?.["admin_district"];
          out.set(canonical(r.query), {
            latitude: lat,
            longitude: lng,
            district: typeof district === "string" ? district : undefined,
          });
        }
      }
    },
    CONCURRENCY,
  );
  return out;
}
