// Server-only loader for the base FSA venue dataset.
//
// In production the dataset lives in Supabase Storage (refreshed weekly by the
// GitHub Actions job — see .github/workflows/fsa-refresh.yml) and is fetched by
// URL via NEXT_PUBLIC_DATASET_URL. Locally, when that env var isn't set, it
// falls back to the bundled public/uk-restaurants.json so dev still works.
//
// Callers only need id/name/postcode; the blob has many more fields, ignored here.

import fs from "node:fs/promises";
import path from "node:path";

export interface BaseVenueRow {
  id: string;
  name: string;
  postcode?: string;
}

// Warm-instance cache: the dataset is ~43MB / 134k rows and every customer-sync
// (hourly) and opening-scan (6h) run used to re-fetch + re-parse the whole blob
// from scratch. Cache the parsed projection in module scope with a short TTL so
// back-to-back runs on the same warm serverless instance reuse it. Keyed by the
// source (URL or disk) so a config change invalidates naturally.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let cache: { key: string; at: number; rows: BaseVenueRow[] } | null = null;

async function loadFresh(): Promise<BaseVenueRow[]> {
  const url = process.env.NEXT_PUBLIC_DATASET_URL;
  if (url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`dataset fetch ${res.status} from ${url}`);
    const data = (await res.json()) as { venues?: BaseVenueRow[] };
    return data.venues ?? [];
  }
  const file = path.join(process.cwd(), "public", "uk-restaurants.json");
  const data = JSON.parse(await fs.readFile(file, "utf8")) as { venues?: BaseVenueRow[] };
  return data.venues ?? [];
}

export async function loadBaseVenues(): Promise<BaseVenueRow[]> {
  const key = process.env.NEXT_PUBLIC_DATASET_URL ? `url:${process.env.NEXT_PUBLIC_DATASET_URL}` : "file";
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await loadFresh();
  cache = { key, at: now, rows };
  return rows;
}
