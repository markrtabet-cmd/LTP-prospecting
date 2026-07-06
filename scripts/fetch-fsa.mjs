// Daily data refresh: FSA → geocode backfill → score → Google Places enrichment → write JSON.
//
// Run with:  node scripts/fetch-fsa.mjs
//
// Requires GOOGLE_PLACES_API_KEY in .env.local (or set in the environment).
// If the key is absent the script still runs but skips Places enrichment.
//
// What it does:
//   1. Loads existing public/london-restaurants.json to preserve the enrichment
//      cache and detect which venues are genuinely new this run.
//   2. Fetches all Restaurant/Cafe/Canteen FSA establishments in Greater London.
//   3. Backfills geocode for the ~12% of FSA records with no lat/lng (FSA data
//      quality gap, not location-specific) using postcodes.io postcode centroids —
//      otherwise those venues are unplaceable on the map and get silently dropped.
//   4. Diffs by FHRSID — new IDs are flagged with firstSeenDate = today.
//   5. Scores every venue (cuisine fit × price tier).
//   6. Enriches venues with leadScore >= ENRICH_MIN using the Google Places
//      (New) Text Search API — phone, website, confirmed business status, price.
//      Venues enriched within ENRICH_TTL_DAYS days are skipped to limit costs.
//   7. Writes the updated public/london-restaurants.json.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Config ─────────────────────────────────────────────────────────────────────

const FSA_PAGE_SIZE   = 5000;
const FSA_BIZ_TYPE    = 1;           // Restaurant / Cafe / Canteen
const OUTPUT          = "public/uk-restaurants.json";

// Only call Google Places for venues scoring at or above this threshold.
// Keeps API costs down — no point enriching kebab shops or fast-food chains.
const ENRICH_MIN      = 60;          // out of 100
const ENRICH_TTL_DAYS = 30;          // skip re-enrichment if fresher than this
const PLACES_CONCURRENCY = 8;        // concurrent Places requests (well under QPS limit)

// Google Places (New) endpoints & field mask
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
// nationalPhoneNumber + websiteUri are "Contact" data — billed at ~$40/1000
const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.priceLevel",
  "places.primaryType",
  "places.types",
].join(",");

// Cuisine-only classification call — "Basic" data (id/name/types), no Contact
// or Atmosphere fields, so it's billed at the cheaper Basic-Data rate rather
// than the ~$40/1000 the full enrichment call above pays for phone/website.
// Used to catch up the large backlog of "Other / Unknown" venues that never
// scored high enough to qualify for the full enrichment pass at all.
const PLACES_FIELDS_CLASSIFY = [
  "places.id",
  "places.displayName",
  "places.primaryType",
  "places.types",
].join(",");
const CLASSIFY_TTL_DAYS = 180; // don't keep re-asking Google about the same still-unclassifiable venue

// ── Load .env.local ────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvLocal();
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

// Supabase Storage: where the base dataset is hosted so the app can refresh it
// without a redeploy, and where the enrichment cache persists between CI runs.
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.DATASET_BUCKET ?? "datasets";
const OBJECT = "uk-restaurants.json";
const STORAGE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);
const storageObjectUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${OBJECT}`;
const storagePublicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${OBJECT}`;

// ── FSA ────────────────────────────────────────────────────────────────────────

async function getFsaPage(pageNumber) {
  const url =
    `https://api.ratings.food.gov.uk/Establishments?businessTypeId=${FSA_BIZ_TYPE}` +
    `&pageSize=${FSA_PAGE_SIZE}&pageNumber=${pageNumber}`;
  const res = await fetch(url, { headers: { "x-api-version": "2", accept: "application/json" } });
  if (!res.ok) throw new Error(`FSA page ${pageNumber} → HTTP ${res.status}`);
  return res.json();
}

// ── Geocode backfill (postcodes.io) ────────────────────────────────────────────
//
// FSA leaves geocode.latitude/longitude null for a large chunk of establishments
// (observed ~12% UK-wide, e.g. "Tortello" FHRSID 1898840) — not a London/rural
// pattern, just a data-quality gap. Without coordinates a venue can't be placed
// on the map, so it was previously dropped silently. postcodes.io is a free,
// keyless UK postcode-lookup API; its bulk endpoint takes up to 100 postcodes
// per request and returns the postcode's centroid lat/lng, which is precise
// enough for prospecting (a UK postcode typically covers a single street/block).

const POSTCODES_IO_BULK_URL = "https://api.postcodes.io/postcodes";
const POSTCODE_BATCH_SIZE = 100; // postcodes.io bulk lookup max per request
const POSTCODE_CONCURRENCY = 5;

async function lookupPostcodeBatch(postcodes) {
  try {
    const res = await fetch(POSTCODES_IO_BULK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes }),
    });
    if (!res.ok) {
      console.warn(`  postcodes.io ${res.status} for a batch of ${postcodes.length}`);
      return [];
    }
    const data = await res.json();
    return data.result ?? [];
  } catch (e) {
    console.warn(`  postcodes.io error: ${e.message}`);
    return [];
  }
}

// Returns Map<normalized postcode, { latitude, longitude }> for every postcode
// that postcodes.io could resolve. Establishments with no postcode, or an
// unrecognised one, are simply absent from the map (still dropped downstream).
async function backfillGeocodesByPostcode(establishments) {
  const postcodes = [...new Set(
    establishments.map((e) => (e.PostCode || "").trim().toUpperCase()).filter(Boolean)
  )];
  const batches = [];
  for (let i = 0; i < postcodes.length; i += POSTCODE_BATCH_SIZE) {
    batches.push(postcodes.slice(i, i + POSTCODE_BATCH_SIZE));
  }

  const geoByPostcode = new Map();
  let done = 0;
  await runPool(batches, async (batch) => {
    const results = await lookupPostcodeBatch(batch);
    for (const r of results) {
      if (r.result?.latitude != null && r.result?.longitude != null) {
        geoByPostcode.set(r.query, { latitude: r.result.latitude, longitude: r.result.longitude });
      }
    }
    done++;
    if (done % 10 === 0 || done === batches.length) {
      process.stdout.write(`  ${done}/${batches.length} postcode batches resolved\r`);
    }
  }, POSTCODE_CONCURRENCY);

  console.log(`\n  Resolved ${geoByPostcode.size}/${postcodes.length} unique postcodes via postcodes.io.`);
  return geoByPostcode;
}

// ── Cuisine / price heuristics ─────────────────────────────────────────────────

function detectCuisine(name) {
  const n = name.toLowerCase();
  const has = (...ks) => ks.some((k) => n.includes(k));
  // Pizza / pasta first — high signal
  if (has("pizz", "forno", "pizza express", "zizzi", "prezzo")) return "Pizza & Pasta";
  // Italian
  if (has("trattor", "osteria", "ristorante", "italian", "cucina", "pasta", "gnocch", "napoli", "naples",
           "milano", "milan", "romano", "amalfi", "toscana", "venezia", "venice", "sicilia", "firenze",
           "sardinia", "puglia", "al dente", "al forno", "la dolce", "la trattoria", "la pasta",
           "la cucina", "la famiglia", "la piazza", "bella italia", "fratelli", "al porto")) return "Italian";
  // Japanese
  if (has("sushi", "sashimi", "japan", "ramen", "katsu", "izakaya", "wasabi", "sakura",
           "teriyaki", "bento", "udon", "tonkotsu", "yakitori", "wagyu", "miso", "omakase",
           "nobu", "matsuri", "zuma", "roka", "kikuchi", "engawa", "kurobuta")) return "Japanese / Sushi";
  // Thai
  if (has("thai", "bangkok", "lemongrass", "siam", "pad thai", "som tam", "khao", "lotus thai")) return "Thai";
  // Chinese
  if (has("chinese", "china", " wok", "noodle", "dim sum", "dumpling", "szechuan", "sichuan",
           "canton", "peking", "oriental", "yum cha", "hot pot", "baozi", "xiao long",
           "hutong", "ping pong", "hakkasan", "yauatcha")) return "Chinese";
  // Indian
  if (has("india", "tandoor", "masala", "curry", "biryani", "bombay", "delhi", "punjab",
           "balti", "tikka", "chutney", "lassi", "dal ", "dosa", "naan", "chai",
           "dishoom", "gymkhana", "benares", "tamarind")) return "Indian";
  // Korean
  if (has("korean", "bibimbap", "kimchi", "pojang", "seoul", "jjigae", "galbi")) return "Other / Unknown";
  // Mexican / Latin
  if (has("mexican", "taco", "burrito", "guacamol", "jalap", "nacho", "fajita", "quesadill",
           "hacienda", "wahaca", "tortilla")) return "Other / Unknown";
  // Burgers
  if (has("burger", "patty", "smash", "shake shack", "five guys", "honest burger",
           "dirty burger", "bleecker")) return "Burgers";
  // Fried chicken
  if (has("fried chicken", "chicken cottage", "perfect fried", "chicken shop", "kfc",
           "popeyes", "nando")) return "Fried chicken";
  // Wings (keep separate from fried chicken shop)
  if (has(" wings") && has("bar", "sports", "american")) return "Fried chicken";
  // Kebab
  if (has("kebab", "shawarma", "doner", "donner", "iskender")) return "Kebab";
  // Greek
  if (has("greek", "souvlaki", "mykonos", "athena", "gyros", "taverna", "hellenic",
           "crete", "athens", "cyprus", "mezedopolio")) return "Greek";
  // Spanish / Tapas
  if (has("tapas", "spanish", "iberica", "tapeo", "catalan", "paella", "bodega",
           "andalucia", "rioja", "pintxo", "basque")) return "Spanish / Tapas";
  // Middle Eastern
  if (has("lebanese", "turkish", "persian", "beirut", "ottoman", "levant", "mezze", "meze",
           "falafel", "anatolia", "kurdish", "arabic", "hummus", "fattoush", "arabian",
           "maroush", "noura", "ranoush", "comptoir libanais")) return "Middle Eastern";
  // Mediterranean (broad)
  if (has("mediterran", "riviera")) return "Mediterranean";
  // French
  if (has("brasserie", "french", "maison", "bistro", "provence", "bordeaux", "lyon",
           "normandy", "alsace", "escargot", "coq au vin", "bouillabaisse", "crepe",
           "le gavroche", "la petite", "le manoir", "boulestin")) return "French";
  // Steakhouse / Grill
  if (has("steak", "grill", "smokehouse", "bbq", "barbecue", "smoked", "hawksmoor",
           "goodman", "maze grill", "chop house", "cut ")) return "Steakhouse";
  // Seafood
  if (has("seafood", "oyster", "fishery", "prawn", "lobster", "crab", "fish market",
           "scott's", "j sheekey", "sheekey", "bentley's", "fishmonger")) return "Seafood";
  // British / Modern British
  if (has("british", "carvery", "sunday roast", "pie & mash", "pie and mash",
           "fish & chips", "fish and chips", "chippy", "chip shop", "rib room",
           "afternoon tea", "claret", "the ivy", "rules restaurant",
           "roast ", " roast", "pudding", "yorkshire")) return "British";
  // Vegan / Plant-based
  if (has("vegan", "plant based", "plant-based", "vegetarian", "veggie")) return "Vegan / Plant-based";
  // Deli / Mediterranean
  if (has("deli", "delicatessen", "larder", "charcuterie", "épicerie")) return "Deli / Mediterranean";
  // Gastro-pub
  if (has("pub", "tavern", " arms", " inn", " tap", "alehouse", "gastropub", "freehouse")) return "Gastro-pub";
  // Cafe / Coffee (check before generic "kitchen" etc.)
  if (has("cafe", "caffe", "coffee", "espresso", "costa", "starbucks", "pret", "barista",
           "bakery", "patisserie", "boulangerie", "croissant", "brunch cafe")) return "Cafe / Coffee";
  // Modern European — fine dining signals with no stronger cuisine match
  if (has("modern european", "fine dining", "tasting menu", "atelier", "chef's table")) return "Modern European";
  // Hotel restaurants are often Modern European
  if (has(" hotel ") || n.startsWith("hotel ")) return "Modern European";
  return "Other / Unknown";
}

const PREMIUM_AREAS = ["W1", "SW1", "SW3", "SW7", "SW10", "W8", "W11", "WC2", "EC2", "EC3", "EC4", "NW3"];

function detectPrice(name, postcode, cuisine) {
  const n = name.toLowerCase();
  const outward = (postcode || "").toUpperCase().split(" ")[0];
  let p = 2;
  if (PREMIUM_AREAS.some((a) => outward.startsWith(a))) p += 1;
  if (/trattor|osteria|ristorante|brasserie|grill|steak|fine dining|members|club/.test(n)) p += 1;
  if (/express|takeaway|take away|kebab|fried chicken|chicken|burger|fast food|cafe|caffe|coffee|snack|chippy|chip shop|food to go|pizza hut|domino|mcdonald|kfc|subway|greggs|pret/.test(n)) p = 1;
  if (cuisine === "Cafe / Coffee") p = Math.min(p, 2);
  return Math.max(1, Math.min(4, p));
}

// ── Lead scoring (mirrors src/lib/mock-data.ts) ────────────────────────────────

const CUISINE_COMPAT = {
  "Italian": 1.0, "Modern Italian": 1.0, "Italian / European": 0.95,
  "Modern European": 0.78, "Mediterranean": 0.7, "Caterer / Events": 0.7,
  "Deli / Mediterranean": 0.68, "French": 0.65, "Gastro-pub": 0.62,
  "Greek": 0.6, "Pizza & Pasta": 0.6, "Spanish / Tapas": 0.58,
  "British": 0.55, "Seafood": 0.5, "Steakhouse": 0.48,
  "Vegan / Plant-based": 0.45, "Other / Unknown": 0.4,
  "Middle Eastern": 0.2, "Cafe / Coffee": 0.2, "Indian": 0.2,
  "Chinese": 0.2, "Thai": 0.2, "Japanese / Sushi": 0.1,
  "Burgers": 0.0, "Fried chicken": 0.0, "Kebab": 0.0,
};

function leadScore(cuisine, priceTier) {
  const compat = CUISINE_COMPAT[cuisine] ?? 0.3;
  return Math.round(compat * 50) + Math.round((priceTier / 4) * 50);
}

// Google Places (New) "type" taxonomy → our cuisine categories. Google's
// classification (trained on real listings/menus/reviews) is far more
// reliable than guessing from the business name alone — this is what lets us
// classify names like "Tortello" that carry no cuisine signal in the name
// itself. Only maps types with a confident, specific match; anything else
// (generic "restaurant", "asian_restaurant", etc.) is left as Other/Unknown
// rather than guessed.
const GOOGLE_TYPE_TO_CUISINE = {
  italian_restaurant: "Italian",
  pizza_restaurant: "Pizza & Pasta",
  japanese_restaurant: "Japanese / Sushi",
  sushi_restaurant: "Japanese / Sushi",
  ramen_restaurant: "Japanese / Sushi",
  thai_restaurant: "Thai",
  chinese_restaurant: "Chinese",
  indian_restaurant: "Indian",
  hamburger_restaurant: "Burgers",
  barbecue_restaurant: "Steakhouse",
  steak_house: "Steakhouse",
  seafood_restaurant: "Seafood",
  greek_restaurant: "Greek",
  spanish_restaurant: "Spanish / Tapas",
  lebanese_restaurant: "Middle Eastern",
  middle_eastern_restaurant: "Middle Eastern",
  turkish_restaurant: "Middle Eastern",
  mediterranean_restaurant: "Mediterranean",
  french_restaurant: "French",
  vegan_restaurant: "Vegan / Plant-based",
  vegetarian_restaurant: "Vegan / Plant-based",
  deli: "Deli / Mediterranean",
  sandwich_shop: "Deli / Mediterranean",
  pub: "Gastro-pub",
  bar_and_grill: "Gastro-pub",
  wine_bar: "Gastro-pub",
  bar: "Gastro-pub",
  cafe: "Cafe / Coffee",
  coffee_shop: "Cafe / Coffee",
  bakery: "Cafe / Coffee",
  tea_house: "Cafe / Coffee",
  breakfast_restaurant: "Cafe / Coffee",
  brunch_restaurant: "Cafe / Coffee",
  dessert_shop: "Cafe / Coffee",
  ice_cream_shop: "Cafe / Coffee",
  donut_shop: "Cafe / Coffee",
  bagel_shop: "Cafe / Coffee",
  juice_shop: "Cafe / Coffee",
  fine_dining_restaurant: "Modern European",
};

// Pick the first type in Google's list (primaryType first, then the ranked
// `types` array) that maps to one of our cuisine categories.
function cuisineFromPlaceTypes(primaryType, types) {
  const candidates = [primaryType, ...(types ?? [])].filter(Boolean);
  for (const t of candidates) {
    const mapped = GOOGLE_TYPE_TO_CUISINE[t];
    if (mapped) return mapped;
  }
  return null;
}

// ── Google Places enrichment ───────────────────────────────────────────────────

// Maps Google Places (New) priceLevel enum → our 1-4 tier
const GOOGLE_PRICE = {
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE:    2,
  PRICE_LEVEL_EXPENSIVE:   3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// Loose name similarity check to avoid accepting a completely wrong Place result.
function namesSimilar(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na) || na.slice(0, 5) === nb.slice(0, 5);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Google's places:searchText quota is 600 requests/minute PER PROJECT, shared
// across the enrichment and classify calls below (same underlying quota
// metric regardless of field mask) — confirmed live: a burst at concurrency 8
// exhausted it after ~600 calls. Stay a safe margin under it rather than
// relying on retries alone to absorb a sustained overshoot.
class RateLimiter {
  constructor(maxPerWindow, windowMs) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.timestamps = [];
  }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(now);
        return;
      }
      await sleep(Math.max(this.windowMs - (now - this.timestamps[0]) + 25, 25));
    }
  }
}
const placesLimiter = new RateLimiter(500, 60_000);
const PLACES_MAX_ATTEMPTS = 4;

// Shared HTTP core for both the full-enrichment and classify-only calls.
// Returns { place } (place may be null — genuinely no result) on a completed
// request, or { rateLimited: true } if still 429 after retries — callers
// must NOT mark that venue as "checked" in that case, so it's retried on a
// future run instead of silently waiting out the full TTL never having had
// a real attempt (exactly what happened on 2026-07-06's first classify run).
async function searchPlace(fieldMask, venue, label) {
  const query = `${venue.name} ${venue.postcode}`;
  for (let attempt = 1; attempt <= PLACES_MAX_ATTEMPTS; attempt++) {
    await placesLimiter.acquire();
    try {
      const res = await fetch(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_API_KEY,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify({
          textQuery: query,
          locationBias: {
            circle: {
              // Use the venue's own coordinates so the bias works for any UK location
              center: { latitude: venue.latitude, longitude: venue.longitude },
              radius: 500.0, // 500 m — tight bias around the exact venue
            },
          },
          maxResultCount: 1,
        }),
      });

      if (res.status === 429) {
        if (attempt === PLACES_MAX_ATTEMPTS) return { rateLimited: true };
        await sleep(2000 * attempt); // back off and let the per-minute window clear
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`  Places(${label}) ${res.status} for "${query}": ${text.slice(0, 120)}`);
        return { place: null };
      }
      const data = await res.json();
      return { place: data.places?.[0] ?? null };
    } catch (e) {
      if (attempt === PLACES_MAX_ATTEMPTS) {
        console.warn(`  Places(${label}) error for "${query}": ${e.message}`);
        return { place: null };
      }
      await sleep(1000 * attempt);
    }
  }
  return { rateLimited: true };
}

async function enrichWithPlaces(venue) {
  const { place, rateLimited } = await searchPlace(PLACES_FIELDS, venue, "enrich");
  if (rateLimited) return { rateLimited: true };
  if (!place) return null;

  // Basic sanity check: reject clearly wrong matches
  const googleName = place.displayName?.text ?? "";
  if (!namesSimilar(venue.name, googleName)) return null;

  return {
    googlePlaceId:  place.id ?? undefined,
    phone:          place.nationalPhoneNumber ?? undefined,
    website:        place.websiteUri ?? undefined,
    businessStatus: place.businessStatus ?? undefined,
    // Only override our heuristic price when Google actually has a value
    priceTier: GOOGLE_PRICE[place.priceLevel] ?? undefined,
    cuisine: cuisineFromPlaceTypes(place.primaryType, place.types) ?? undefined,
  };
}

// Cheaper cuisine-only lookup (Basic Data fields only — no phone/website/price)
// for the large backlog of low-scoring venues that never qualify for the full
// enrichment call above. Same query/bias/name-check, fewer fields billed.
async function classifyWithPlaces(venue) {
  const { place, rateLimited } = await searchPlace(PLACES_FIELDS_CLASSIFY, venue, "classify");
  if (rateLimited) return { rateLimited: true };
  if (!place) return null;

  const googleName = place.displayName?.text ?? "";
  if (!namesSimilar(venue.name, googleName)) return null;

  const cuisine = cuisineFromPlaceTypes(place.primaryType, place.types);
  return cuisine ? { cuisine } : null;
}

// ── Concurrency pool ───────────────────────────────────────────────────────────

async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isStale(dateStr, ttlDays = ENRICH_TTL_DAYS) {
  if (!dateStr) return true; // never enriched
  return Date.now() - new Date(dateStr).getTime() > ttlDays * 86_400_000;
}

// ── Supabase Storage (base dataset host + enrichment cache) ─────────────────────

// Create the bucket (public) if it doesn't exist yet — makes first-time setup
// a no-op beyond providing the Supabase env vars.
async function ensureBucket() {
  const check = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
  });
  if (check.ok) return;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!res.ok && res.status !== 409) {
    console.warn(`  Bucket create ${res.status}: ${(await res.text()).slice(0, 160)}`);
  } else {
    console.log(`Created public Storage bucket "${BUCKET}".`);
  }
}

// Pull the last uploaded dataset so enrichment/firstSeen carry over between runs.
async function downloadPreviousFromStorage() {
  try {
    const res = await fetch(storageObjectUrl, {
      headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
    });
    if (res.status === 404) return null; // first run — nothing uploaded yet
    if (!res.ok) {
      console.warn(`  Storage download ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`  Storage download error: ${e.message}`);
    return null;
  }
}

async function uploadToStorage(payloadStr) {
  const res = await fetch(storageObjectUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      "x-upsert": "true", // overwrite the existing object
      "cache-control": "max-age=86400",
    },
    body: payloadStr,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const todayStr = today();

  // 1. Load the previous dataset to preserve the enrichment cache and diff
  //    against it. Prefer Supabase Storage (survives CI runs) then local disk.
  const prevById = new Map(); // fhrsId (string) → previous venue record
  let prev = null;
  if (STORAGE_ENABLED) {
    await ensureBucket();
    prev = await downloadPreviousFromStorage();
    if (prev) console.log(`Loaded previous dataset from Supabase Storage (${prev.venues?.length ?? 0} venues).`);
  }
  if (!prev && existsSync(OUTPUT)) {
    try {
      prev = JSON.parse(readFileSync(OUTPUT, "utf8"));
      console.log(`Loaded previous dataset from ${OUTPUT}.`);
    } catch {
      console.warn("Could not parse existing JSON — starting fresh.");
    }
  }
  if (prev) {
    for (const v of prev.venues ?? []) prevById.set(v.id.replace("fsa-", ""), v);
  }

  // 2. Fetch FSA
  console.log(`\nFetching FSA establishments UK-wide…`);
  const seen = new Set();
  const fsaRaw = [];
  let page = 1, total = Infinity;

  while (fsaRaw.length < total) {
    const json = await getFsaPage(page);
    total = json.meta?.totalCount ?? fsaRaw.length;
    const ests = json.establishments ?? [];
    if (!ests.length) break;
    for (const e of ests) {
      if (seen.has(e.FHRSID)) continue;
      seen.add(e.FHRSID);
      // Geocode may be missing here (~12% of FSA records) — backfilled by
      // postcode below, so don't drop for that reason at this stage.
      fsaRaw.push(e);
    }
    console.log(`  page ${page}: ${fsaRaw.length} / ${total}`);
    page++;
    if (page > 40) break; // safety (UK-wide needs ~28 pages)
  }

  // 2b. Backfill geocode for establishments FSA didn't supply one for.
  const missingGeocode = fsaRaw.filter((e) => {
    const lat = parseFloat(e.geocode?.latitude);
    const lng = parseFloat(e.geocode?.longitude);
    return !Number.isFinite(lat) || !Number.isFinite(lng);
  });
  console.log(
    `\n${missingGeocode.length} establishments have no FSA geocode — backfilling from postcode…`
  );
  const postcodeGeo = missingGeocode.length
    ? await backfillGeocodesByPostcode(missingGeocode)
    : new Map();

  // 3. Build venue records — diff against previous run
  const venues = [];
  let newCount = 0;
  let geocodeRescued = 0;
  let geocodeDropped = 0;

  for (const e of fsaRaw) {
    const fhrsId = String(e.FHRSID);
    const id     = `fsa-${fhrsId}`;
    const prev   = prevById.get(fhrsId);

    const name   = titleCase(e.BusinessName || "Unknown");
    const postcode = (e.PostCode || "").trim().toUpperCase();
    // Preserve a previously classified cuisine (fix-cuisine / AI) unless it was
    // still unclassified ("Other / Unknown") — then re-run detection.
    const detectedCuisine = detectCuisine(e.BusinessName || "");
    const cuisine = (prev?.cuisineType && prev.cuisineType !== "Other / Unknown")
      ? prev.cuisineType
      : detectedCuisine;
    const addr   = [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4]
      .filter((x) => x?.trim()).map(titleCase).join(", ");

    let lat = parseFloat(e.geocode?.latitude);
    let lng = parseFloat(e.geocode?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const geo = postcodeGeo.get(postcode);
      if (geo) {
        lat = geo.latitude;
        lng = geo.longitude;
        geocodeRescued++;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      geocodeDropped++;
      continue; // no coordinates at all — can't place on the map
    }
    lat = Number(lat.toFixed(5));
    lng = Number(lng.toFixed(5));

    const rating = parseInt(e.RatingValue, 10);

    // FSA's own inspection date — independent of our pipeline's history, so
    // it survives pipeline gaps (like the geocode-drop bug) intact. FSA uses
    // 1901-01-01 as a sentinel for "never inspected yet"; treat that as no
    // date rather than a real (very old) one.
    const ratingDateMs = e.RatingDate ? Date.parse(e.RatingDate) : NaN;
    const ratingDate = Number.isFinite(ratingDateMs) && ratingDateMs > Date.parse("1902-01-01")
      ? new Date(ratingDateMs).toISOString().slice(0, 10)
      : undefined;

    // Use the previous (potentially Google-enriched) price tier if we have it,
    // otherwise fall back to the name/postcode heuristic.
    const priceTier = prev?.priceTier ?? detectPrice(e.BusinessName || "", postcode, cuisine);

    if (!prev) newCount++;

    venues.push({
      id,
      name,
      address: addr,
      postcode,
      borough:      e.LocalAuthorityName || "Unknown",
      latitude:     lat,
      longitude:    lng,
      hygieneRating: Number.isFinite(rating) ? rating : undefined,
      ratingDate,
      cuisineType:  cuisine,
      priceTier,
      // Carry forward enriched contact / metadata from previous run
      phone:          prev?.phone,
      website:        prev?.website,
      googlePlaceId:  prev?.googlePlaceId,
      businessStatus: prev?.businessStatus,
      enrichedAt:     prev?.enrichedAt,
      cuisineCheckedAt: prev?.cuisineCheckedAt,
      firstSeenDate:  prev?.firstSeenDate ?? todayStr,
      lastSeenDate:   todayStr,
    });
  }

  console.log(`\nFSA: ${venues.length} venues total, ${newCount} new since last run.`);

  // 4. Score all venues (needed to decide what to enrich)
  for (const v of venues) {
    v._score = leadScore(v.cuisineType, v.priceTier);
  }

  // 5. Google Places enrichment
  if (!GOOGLE_API_KEY) {
    console.warn("\nNo GOOGLE_PLACES_API_KEY found — skipping Places enrichment.");
    console.warn("Add GOOGLE_PLACES_API_KEY to .env.local and re-run to enrich.");
  } else {
    const toEnrich = venues.filter(
      (v) => v._score >= ENRICH_MIN && isStale(v.enrichedAt)
    );

    console.log(`\nEnriching ${toEnrich.length} venues with Google Places…`);
    console.log(`  (score ≥ ${ENRICH_MIN}, not enriched in the last ${ENRICH_TTL_DAYS} days)`);
    console.log(`  Estimated cost: ~$${((toEnrich.length / 1000) * 40).toFixed(2)} USD`);

    let done = 0, contacts = 0;

    await runPool(toEnrich, async (venue) => {
      const result = await enrichWithPlaces(venue);
      if (result?.rateLimited) {
        // Still 429 after retries — leave enrichedAt untouched so this venue
        // is retried on a future run rather than treated as "checked" for
        // ENRICH_TTL_DAYS despite never getting a real answer.
        done++;
        return;
      }
      if (result) {
        if (result.phone || result.website) contacts++;
        // Merge enrichment into venue
        if (result.googlePlaceId)  venue.googlePlaceId  = result.googlePlaceId;
        if (result.phone)          venue.phone          = result.phone;
        if (result.website)        venue.website        = result.website;
        if (result.businessStatus) venue.businessStatus = result.businessStatus;
        if (result.priceTier)      venue.priceTier      = result.priceTier;
        // Only fill in cuisine when we still have no confident classification —
        // never overrule an existing specific (name-heuristic) guess.
        if (result.cuisine && venue.cuisineType === "Other / Unknown") venue.cuisineType = result.cuisine;
      }
      // Mark as attempted even if Google found nothing — avoids retrying every week
      venue.enrichedAt = todayStr;
      venue.cuisineCheckedAt = todayStr;

      done++;
      if (done % 50 === 0 || done === toEnrich.length) {
        process.stdout.write(`  ${done}/${toEnrich.length} enriched, ${contacts} contacts found\r`);
      }
    }, PLACES_CONCURRENCY);

    console.log(`\n  Complete: ${contacts} phone/website contacts found out of ${toEnrich.length} enriched.`);

    // 5b. Cuisine-only catch-up: "Other / Unknown" venues that never scored
    // high enough to qualify for the full enrichment pass above (most of
    // them — cuisineFit alone caps their score well below ENRICH_MIN) never
    // got a Places lookup at all, so they can never self-correct. Use the
    // cheaper Basic-Data-only call to classify them without paying Contact
    // Data rates for venues we're not trying to get phone/website for here.
    const toClassify = venues.filter(
      (v) => v.cuisineType === "Other / Unknown" && isStale(v.cuisineCheckedAt, CLASSIFY_TTL_DAYS)
    );

    console.log(`\nClassifying ${toClassify.length} unclassified ("Other / Unknown") venues with Google Places…`);
    console.log(`  (cuisine-only lookup, Basic Data fields — cheaper than the contact-enrichment call above)`);

    let classifyDone = 0, classified = 0;

    await runPool(toClassify, async (venue) => {
      const result = await classifyWithPlaces(venue);
      if (result?.rateLimited) {
        // Still 429 after retries — leave cuisineCheckedAt untouched so this
        // venue is retried on a future run instead of waiting out the full
        // 180-day TTL having never gotten a real attempt.
        classifyDone++;
        return;
      }
      if (result?.cuisine) {
        venue.cuisineType = result.cuisine;
        classified++;
      }
      // Mark as attempted regardless — avoids re-querying the same
      // still-unclassifiable venue on every future run.
      venue.cuisineCheckedAt = todayStr;

      classifyDone++;
      if (classifyDone % 200 === 0 || classifyDone === toClassify.length) {
        process.stdout.write(`  ${classifyDone}/${toClassify.length} checked, ${classified} classified\r`);
      }
    }, PLACES_CONCURRENCY);

    console.log(`\n  Complete: ${classified} of ${toClassify.length} previously-unclassified venues now have a real cuisine.`);
  }

  // 6. Clean up internal score field and write output
  for (const v of venues) delete v._score;

  mkdirSync("public", { recursive: true });
  const payload = {
    generatedAt: todayStr,
    source:      "Food Standards Agency + Google Places — UK",
    totalCount:  venues.length,
    newThisRun:  newCount,
    venues,
  };
  const payloadStr = JSON.stringify(payload);
  writeFileSync(OUTPUT, payloadStr);

  if (STORAGE_ENABLED) {
    await uploadToStorage(payloadStr);
    console.log(`\nUploaded dataset to Supabase Storage bucket "${BUCKET}".`);
    console.log(`  Set this as NEXT_PUBLIC_DATASET_URL (locally + in Vercel):`);
    console.log(`  ${storagePublicUrl}`);
  } else {
    console.log(`\n(Supabase env vars not set — wrote local file only, no upload.)`);
  }

  // Summary
  const withPhone   = venues.filter((v) => v.phone).length;
  const withWebsite = venues.filter((v) => v.website).length;
  const enriched    = venues.filter((v) => v.enrichedAt).length;

  console.log(`\nWrote ${OUTPUT}`);
  console.log(`  Total venues     : ${venues.length}`);
  console.log(`  New this run     : ${newCount}`);
  console.log(`  Geocode rescued  : ${geocodeRescued} (FSA had no lat/lng, resolved via postcode)`);
  console.log(`  Geocode dropped  : ${geocodeDropped} (no postcode match — excluded from map)`);
  console.log(`  Enriched         : ${enriched} (Google Places attempted)`);
  console.log(`  With phone       : ${withPhone} (${Math.round((withPhone / venues.length) * 100)}%)`);
  console.log(`  With website     : ${withWebsite} (${Math.round((withWebsite / venues.length) * 100)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
