// Backfill cuisine for the LIVE dataset in Supabase Storage.
//
//   node scripts/reclassify-cuisine-storage.mjs            # full run, uploads
//   node scripts/reclassify-cuisine-storage.mjs --sample 5 # dry test, no upload
//   node scripts/reclassify-cuisine-storage.mjs --no-upload # process, save local only
//
// Pipeline:
//   1. Download the current dataset from Supabase Storage (the object the app
//      serves via NEXT_PUBLIC_DATASET_URL).
//   2. Name-detect kebab / doner and ice-cream / gelato venues across the WHOLE
//      dataset and force cuisine + excluded (never-valid prospects).
//   3. AI-classify every remaining "Other" / "Other / Unknown" venue from its
//      name + borough + postcode, conservatively (keep "Other" when unclear).
//   4. Rescore, preserve the payload metadata, upload back to Storage.
//
// Existing customers and manual overrides are NOT touched here (that's the app's
// job) — this only relabels the base FSA dataset.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ── Env ───────────────────────────────────────────────────────────────────────
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

const args = process.argv.slice(2);
const SAMPLE = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1] || 5) : 0;
const NO_UPLOAD = args.includes("--no-upload") || SAMPLE > 0;
const MODEL = process.env.CUISINE_MODEL || "claude-sonnet-5";
const BATCH_SIZE = 50;
const CONCURRENCY = 8;
const CHECKPOINT = "/private/tmp/claude-501/-Users-marktabet-Developer-Restaurant-Prospector/bb2a9438-b497-441d-8d0a-fa386c0e1e34/scratchpad/cuisine-checkpoint.json";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.DATASET_BUCKET ?? "datasets";
const OBJECT = "uk-restaurants.json";
const storageObjectUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${OBJECT}`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Cuisine list + scoring (mirrors mock-data.ts / fetch-fsa.mjs) ──────────────
const VALID_CUISINES = [
  "Italian", "Modern Italian", "Italian / European",
  "Modern European", "French", "Mediterranean", "Deli / Mediterranean",
  "Greek", "Spanish / Tapas", "British", "Gastro-pub",
  "Seafood", "Steakhouse", "Vegan / Plant-based",
  "Pizza & Pasta", "Japanese / Sushi", "Chinese", "Indian", "Thai",
  "Korean", "Vietnamese", "Mexican",
  "Middle Eastern", "Cafe / Coffee", "Burgers", "Fried chicken", "Kebab",
  "Ice cream / Gelato",
  "Other",
];
const CUISINE_SET = new Set(VALID_CUISINES);

const CUISINE_COMPAT = {
  "Italian": 1.0, "Modern Italian": 1.0, "Italian / European": 0.95,
  "Modern European": 0.78, "Mediterranean": 0.7, "Caterer / Events": 0.7,
  "Deli / Mediterranean": 0.68, "French": 0.65, "Gastro-pub": 0.62,
  "Greek": 0.6, "Pizza & Pasta": 0.6, "Spanish / Tapas": 0.58,
  "British": 0.55, "Seafood": 0.5, "Steakhouse": 0.48,
  "Vegan / Plant-based": 0.45, "Other": 0.4, "Other / Unknown": 0.4,
  "Mexican": 0.3,
  "Middle Eastern": 0.2, "Cafe / Coffee": 0.2, "Indian": 0.2, "Korean": 0.2, "Vietnamese": 0.2,
  "Chinese": 0.2, "Thai": 0.2, "Japanese / Sushi": 0.1,
  "Burgers": 0.0, "Fried chicken": 0.0, "Kebab": 0.0, "Ice cream / Gelato": 0.0,
};

function rescore(cuisine, priceTier) {
  const compat = CUISINE_COMPAT[cuisine] ?? 0.4;
  const pt = priceTier || 2;
  const cuisineFit = Math.round(compat * 50);
  const priceFit = Math.round((pt / 4) * 50);
  const leadScore = cuisineFit + priceFit;
  return {
    cuisineFit, priceFit, leadScore,
    leadCategory: leadScore >= 75 ? "high" : leadScore >= 60 ? "good" : leadScore >= 40 ? "possible" : "low",
    excluded: compat < 0.25,
    recommended: compat >= 0.5 && pt >= 3,
  };
}

function applyCuisine(v, cuisine) {
  v.cuisineType = cuisine;
  const s = rescore(cuisine, v.priceTier);
  v.leadScore = s.leadScore;
  v.leadCategory = s.leadCategory;
  v.excluded = s.excluded;
  v.recommended = s.recommended;
  v.scoreBreakdown = { cuisineFit: s.cuisineFit, priceFit: s.priceFit };
}

// ── Never-valid name detectors (kept in sync with src/lib/cuisine.ts) ──────────
const ICE_CREAM_RE = /\b(gelat|ice[-\s]?cream|sorbet|soft[-\s]?serve|creamery|scoop shop|frozen yog|froyo)/i;
const KEBAB_RE = /\b(kebab|kebap|kebob|shawarma|shawurma|shawerma|doner|donner|döner|iskender|lahmacun)/i;

// ── Claude classification ─────────────────────────────────────────────────────
async function classifyBatch(venues) {
  const list = venues
    .map((v, i) => `${i + 1}. "${v.name}" — ${v.borough || "?"}, ${v.postcode || "?"}`)
    .join("\n");

  const prompt = `You are classifying UK restaurants by cuisine for a fresh-pasta supplier. For each venue, pick the single best cuisine from this list:
${VALID_CUISINES.join(", ")}

Rules:
- Base your guess on the NAME, plus borough/postcode cultural signals ("Golden Dragon" → Chinese, "Taj Mahal" → Indian, "Yamamoto" → Japanese / Sushi, "El Toro" → Spanish / Tapas, "La Cucina" → Italian, "The Crown"/"Red Lion" → Gastro-pub, "Costa"/"…Coffee"/"…Bakery" → Cafe / Coffee).
- Use "Modern European" for fine-dining / contemporary names with no single-cuisine signal in upscale central postcodes (W1/SW1/WC/EC).
- Use "British" for traditional British / Sunday-roast venues, "Gastro-pub" for pub names with a food focus.
- Be CONSERVATIVE: only assign a specific cuisine when the name/location gives a reasonable signal. If the name is a person's name, a generic word, a hotel, a members' club, a caterer, or otherwise genuinely ambiguous, return "Other". A confident wrong guess is worse than "Other".
- Never invent cuisines outside the list.

Venues:
${list}

Reply with ONLY a JSON array of ${venues.length} cuisine strings, in order. Example: ["Italian", "Other", "Chinese"]`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });
      // Sonnet may prepend a thinking block, so find the text block by type
      // rather than assuming content[0].
      const textBlock = msg.content.find((b) => b.type === "text");
      const text = textBlock ? textBlock.text.trim() : "[]";
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
      return venues.map((_, j) => (CUISINE_SET.has(arr[j]) ? arr[j] : "Other"));
    } catch (e) {
      if (attempt === 3) {
        console.warn(`  batch failed (${e.message?.slice(0, 120)}) — keeping Other`);
        return venues.map(() => "Other");
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return venues.map(() => "Other");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function downloadDataset() {
  const res = await fetch(storageObjectUrl, {
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
  });
  if (!res.ok) throw new Error(`Storage download ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function uploadDataset(payloadStr) {
  const res = await fetch(storageObjectUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      "x-upsert": "true",
      "cache-control": "max-age=300",
    },
    body: payloadStr,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const run = async () => {
  console.log(`Model: ${MODEL} | sample: ${SAMPLE || "no"} | upload: ${!NO_UPLOAD}`);
  console.log("Downloading live dataset from Supabase Storage…");
  const payload = await downloadDataset();
  const venues = payload.venues || [];
  console.log(`  ${venues.length} venues (generatedAt ${payload.generatedAt}).`);

  // Step 1: never-valid name exclusions across the WHOLE dataset.
  let iceCream = 0, kebab = 0;
  for (const v of venues) {
    if (v.existingCustomer) continue; // safety — customers aren't excluded
    const name = v.name || "";
    if (ICE_CREAM_RE.test(name) && v.cuisineType !== "Ice cream / Gelato") { applyCuisine(v, "Ice cream / Gelato"); iceCream++; }
    else if (KEBAB_RE.test(name) && v.cuisineType !== "Kebab") { applyCuisine(v, "Kebab"); kebab++; }
  }
  console.log(`  Name-excluded: ${iceCream} ice-cream, ${kebab} kebab.`);

  // Step 2: AI-classify remaining Other / Other Unknown.
  let toClassify = venues.filter((v) => v.cuisineType === "Other" || v.cuisineType === "Other / Unknown");
  if (SAMPLE > 0) {
    // Random sample so the dry-run is representative (dataset is name-sorted, so
    // slice(0,N) is all symbol/number-prefixed edge cases).
    for (let i = toClassify.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [toClassify[i], toClassify[j]] = [toClassify[j], toClassify[i]];
    }
    toClassify = toClassify.slice(0, SAMPLE);
  }
  console.log(`  Classifying ${toClassify.length} "Other" venues in ${Math.ceil(toClassify.length / BATCH_SIZE)} batches…`);

  const batches = [];
  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) batches.push(toClassify.slice(i, i + BATCH_SIZE));

  let done = 0, changed = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(
      batches.slice(i, i + CONCURRENCY).map(async (batch) => {
        const results = await classifyBatch(batch);
        for (let j = 0; j < batch.length; j++) {
          const nc = results[j] ?? "Other";
          if (nc !== "Other" && nc !== batch[j].cuisineType) { applyCuisine(batch[j], nc); changed++; }
          else if (batch[j].cuisineType === "Other / Unknown") { applyCuisine(batch[j], "Other"); }
        }
        done += batch.length;
      })
    );
    process.stdout.write(`  ${done}/${toClassify.length} classified, ${changed} reclassified\r`);
    if (SAMPLE === 0 && (i / CONCURRENCY) % 10 === 0) {
      try { writeFileSync(CHECKPOINT, JSON.stringify({ done, changed })); } catch { /* ignore */ }
    }
  }
  console.log(`\n  Done: ${changed}/${toClassify.length} reclassified from "Other".`);

  if (SAMPLE > 0) {
    console.log("\nSAMPLE RESULTS:");
    for (const v of toClassify) console.log(`  ${v.cuisineType.padEnd(22)}  "${v.name}" — ${v.borough}, ${v.postcode}`);
    return;
  }

  const out = { ...payload, totalCount: venues.length, venues };
  const outStr = JSON.stringify(out);
  writeFileSync("/private/tmp/claude-501/-Users-marktabet-Developer-Restaurant-Prospector/bb2a9438-b497-441d-8d0a-fa386c0e1e34/scratchpad/uk-restaurants.reclassified.json", outStr);
  if (NO_UPLOAD) { console.log("  --no-upload: wrote local copy only."); return; }

  console.log("Uploading to Supabase Storage…");
  await uploadDataset(outStr);
  console.log("  Uploaded. Live dataset updated.");
};

run().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
