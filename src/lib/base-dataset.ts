// Server-only loader for the base FSA venue dataset.
//
// In production the dataset lives in Supabase Storage (refreshed by the GitHub
// Actions job — see .github/workflows/fsa-refresh.yml) and is fetched by URL via
// NEXT_PUBLIC_DATASET_URL. Locally, when that env var isn't set, it falls back
// to the bundled public/uk-restaurants.json so dev still works.
//
// The parsed dataset is cached in module scope with a short TTL: it's ~43MB /
// 134k rows and several server callers (the /api/venues route, the customer
// sync, the opening scan) would otherwise each re-fetch + re-parse the whole
// blob on every invocation.

import fs from "node:fs/promises";
import path from "node:path";
import type { RawVenue } from "./mock-data";

// Some callers (customer sync, opening scan) only need id/name/postcode.
export interface BaseVenueRow {
  id: string;
  name: string;
  postcode?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let cache: { key: string; at: number; rows: RawVenue[] } | null = null;

async function loadFresh(): Promise<RawVenue[]> {
  const url = process.env.NEXT_PUBLIC_DATASET_URL;
  if (url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`dataset fetch ${res.status} from ${url}`);
    const data = (await res.json()) as { venues?: RawVenue[] };
    return data.venues ?? [];
  }
  const file = path.join(process.cwd(), "public", "uk-restaurants.json");
  const data = JSON.parse(await fs.readFile(file, "utf8")) as { venues?: RawVenue[] };
  return data.venues ?? [];
}

async function loadCached(): Promise<RawVenue[]> {
  const key = process.env.NEXT_PUBLIC_DATASET_URL ? `url:${process.env.NEXT_PUBLIC_DATASET_URL}` : "file";
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await loadFresh();
  cache = { key, at: now, rows };
  return rows;
}

/** Full venue rows (all fields), for callers that ship them to the client. */
export async function loadFullBaseVenues(): Promise<RawVenue[]> {
  return loadCached();
}

/** Lightweight id/name/postcode view for de-dup / matching callers. The cached
 * full rows already satisfy this shape, so no extra allocation. */
export async function loadBaseVenues(): Promise<BaseVenueRow[]> {
  return (await loadCached()) as unknown as BaseVenueRow[];
}
