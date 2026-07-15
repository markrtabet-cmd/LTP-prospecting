// Server-only postcode geocoder using postcodes.io — the same free, keyless UK
// postcode-centroid API the FSA refresh script uses to backfill venues that FSA
// left without coordinates (see scripts/fetch-fsa.mjs). Its bulk endpoint takes
// up to 100 postcodes per request and returns each postcode's centroid lat/lng
// plus its admin district (borough), which is precise enough for prospecting —
// a UK postcode typically covers a single street/block.

const BULK_URL = "https://api.postcodes.io/postcodes";
const OUTCODE_URL = "https://api.postcodes.io/outcodes";
const BATCH_SIZE = 100; // postcodes.io bulk lookup max per request
const CONCURRENCY = 5;

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  /** Local authority district, e.g. "Westminster" — used as a borough guess. */
  district?: string;
  /** True when only the postcode's OUTWARD code could be placed (approximate,
   * ~district-level) because postcodes.io didn't know the full postcode. */
  approximate?: boolean;
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

// Centroid of a postcode's OUTWARD code (e.g. "EC2M"), used as an approximate
// fallback when the full postcode doesn't resolve. postcodes.io lags Royal Mail
// by months, so a brand-new (or a terminated) real UK postcode misses the full
// lookup even though its outcode is known. Returns null for Channel Islands /
// foreign "outcodes" it doesn't cover (they stay unplaced, as they should).
async function lookupOutcode(outcode: string): Promise<GeocodeResult | null> {
  try {
    const res = await fetch(`${OUTCODE_URL}/${encodeURIComponent(outcode)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: Record<string, unknown> | null };
    const r = data.result;
    const lat = r?.["latitude"];
    const lng = r?.["longitude"];
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    // For an outcode admin_district is an array (an outcode can span districts).
    const districts = r?.["admin_district"];
    const district = Array.isArray(districts) && typeof districts[0] === "string" ? districts[0] : undefined;
    return { latitude: lat, longitude: lng, district, approximate: true };
  } catch {
    return null;
  }
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

  // Fallback for real UK postcodes the full lookup couldn't place: use their
  // outward-code centroid so a genuine customer gets an (approximate) pin instead
  // of vanishing. Only well-formed UK outcodes are tried, so foreign / malformed
  // postcodes (Paris "75016", "213015") are still correctly left unplaced.
  const outcodeByPc = new Map<string, string>();
  for (const pc of unique) {
    if (out.has(pc)) continue;
    const oc = outwardCode(pc);
    if (/^[A-Z]{1,2}\d[A-Z\d]?$/i.test(oc)) outcodeByPc.set(pc, oc.toUpperCase());
  }
  if (outcodeByPc.size) {
    const outcodeCentroid = new Map<string, GeocodeResult | null>();
    const uniqueOutcodes = Array.from(new Set(outcodeByPc.values()));
    await runPool(
      uniqueOutcodes,
      async (oc) => { outcodeCentroid.set(oc, await lookupOutcode(oc)); },
      CONCURRENCY,
    );
    for (const [pc, oc] of Array.from(outcodeByPc)) {
      const g = outcodeCentroid.get(oc);
      if (g && !out.has(pc)) out.set(pc, g);
    }
  }

  return out;
}
