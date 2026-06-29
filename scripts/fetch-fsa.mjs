// Pulls all "Restaurant/Cafe/Canteen" food businesses across Greater London
// from the Food Standards Agency (FSA) open API and writes a compact dataset to
// public/london-restaurants.json.
//
// FSA gives us real name / address / postcode / borough / coordinates / hygiene
// rating / phone. It does NOT give cuisine or price, so we infer both from the
// business name + postcode (clearly heuristic — editable in-app, and the place a
// future LLM / Google Places `price_level` integration would improve).
//
// Run with:  node scripts/fetch-fsa.mjs

import { writeFileSync, mkdirSync } from "node:fs";

const HEADERS = { "x-api-version": "2", accept: "application/json" };
const LAT = 51.5074;
const LNG = -0.1278;
const RADIUS_MILES = 10; // covers Greater London
const PAGE_SIZE = 5000;
const BUSINESS_TYPE_ID = 1; // Restaurant/Cafe/Canteen

async function getPage(pageNumber) {
  const url =
    `https://api.ratings.food.gov.uk/Establishments?businessTypeId=${BUSINESS_TYPE_ID}` +
    `&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}` +
    `&latitude=${LAT}&longitude=${LNG}&maxDistanceLimit=${RADIUS_MILES}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`FSA page ${pageNumber} -> HTTP ${res.status}`);
  return res.json();
}

function detectCuisine(name) {
  const n = name.toLowerCase();
  const has = (...ks) => ks.some((k) => n.includes(k));
  if (has("pizz", "forno")) return "Pizza & Pasta";
  if (has("trattor", "osteria", "ristorante", "italian", "cucina", "pasta", "gnocch", "napoli", "milano", "romano", "amalfi", "toscana")) return "Italian";
  if (has("sushi", "sashimi", "japan", "ramen", "katsu", "izakaya", "wasabi", "sakura", "teriyaki", "bento")) return "Japanese / Sushi";
  if (has("thai", "bangkok", "lemongrass", "siam")) return "Thai";
  if (has("chinese", "china", " wok", "noodle", "dim sum", "dumpling", "szechuan", "sichuan", "canton", "peking", "oriental")) return "Chinese";
  if (has("india", "tandoor", "masala", "curry", "biryani", "bombay", "delhi", "punjab", "balti", "tikka")) return "Indian";
  if (has("burger", "patty", "smash")) return "Burgers";
  if (has("fried chicken", "chicken cottage", "perfect fried", "wings", "chicken shop")) return "Fried chicken";
  if (has("kebab", "shawarma", "doner", "donner")) return "Kebab";
  if (has("greek", "souvlaki", "mykonos", "athena", "gyros")) return "Greek";
  if (has("tapas", "spanish", "iberica", "tapeo", "catalan")) return "Spanish / Tapas";
  // Lebanese / Middle-Eastern have their own staples — NOT a fresh-pasta fit.
  if (has("lebanese", "turkish", "persian", "beirut", "ottoman", "levant", "mezze", "meze", "falafel", "shawarma", "anatolia", "kurdish", "arabic")) return "Middle Eastern";
  if (has("mediterran")) return "Mediterranean";
  if (has("brasserie", "french", "maison", "bistro", "provence")) return "French";
  if (has("steak", "grill", "smokehouse")) return "Steakhouse";
  if (has("seafood", "oyster", "fishery", "prawn", "lobster")) return "Seafood";
  if (has("british", "chop house", "carvery", "sunday roast", "pie & mash", "pie and mash", "fish & chips", "fish and chips", "rib room")) return "British";
  if (has("vegan", "plant based", "vegetarian")) return "Vegan / Plant-based";
  if (has("deli", "delicatessen", "larder")) return "Deli / Mediterranean";
  if (has("pub", "tavern", " arms", " inn", " tap", "alehouse")) return "Gastro-pub";
  if (has("cafe", "caffe", "coffee", "espresso", "costa", "starbucks", "pret", "barista", "bakery", "patisserie")) return "Cafe / Coffee";
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

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function main() {
  console.log(`Fetching FSA restaurants within ${RADIUS_MILES} miles of central London…`);
  const seen = new Set();
  const out = [];
  let page = 1;
  let total = Infinity;

  while (out.length < total) {
    const json = await getPage(page);
    total = json.meta?.totalCount ?? out.length;
    const ests = json.establishments ?? [];
    if (ests.length === 0) break;
    for (const e of ests) {
      if (seen.has(e.FHRSID)) continue;
      seen.add(e.FHRSID);
      const lat = parseFloat(e.geocode?.latitude);
      const lng = parseFloat(e.geocode?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue; // need coords for the map
      const name = titleCase(e.BusinessName || "Unknown");
      const cuisine = detectCuisine(e.BusinessName || "");
      const priceTier = detectPrice(e.BusinessName || "", e.PostCode, cuisine);
      const rating = parseInt(e.RatingValue, 10);
      const addr = [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4]
        .filter((x) => x && x.trim())
        .map((x) => titleCase(x))
        .join(", ");
      out.push({
        id: `fsa-${e.FHRSID}`,
        name,
        address: addr,
        postcode: (e.PostCode || "").toUpperCase(),
        borough: e.LocalAuthorityName || "London",
        latitude: Number(lat.toFixed(5)),
        longitude: Number(lng.toFixed(5)),
        phone: e.Phone || undefined,
        hygieneRating: Number.isFinite(rating) ? rating : undefined,
        cuisineType: cuisine,
        priceTier,
      });
    }
    console.log(`  page ${page}: collected ${out.length}/${total}`);
    page += 1;
    if (page > 12) break; // safety
  }

  mkdirSync("public", { recursive: true });
  const payload = {
    generatedAt: "2026-06-29",
    source: "Food Standards Agency (FSA) — Restaurant/Cafe/Canteen, Greater London",
    totalCount: out.length,
    venues: out,
  };
  writeFileSync("public/london-restaurants.json", JSON.stringify(payload));
  console.log(`\nWrote public/london-restaurants.json with ${out.length} venues.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
