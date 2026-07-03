// Customer sync (server-only): pull the customer list from Power BI, match each
// row to an FSA venue by normalised name + postcode, and flag matches as
// existing customers in the shared Supabase state so the whole team sees them.
//
// This is ADDITIVE: it only ever sets existingCustomer = true. It never removes
// the flag, so a customer dropping out of Power BI (or a manual flag) is left
// untouched — flip POWERBI_SYNC_PRUNE handling in here later if you want that.

import fs from "fs/promises";
import path from "path";
import { isSupabaseConfigured, supabaseAdmin } from "./supabase";
import { loadBaseVenues } from "./base-dataset";
import {
  executePowerBIDaxQuery,
  fetchPowerBICustomers,
  getDatasetLastRefreshTime,
  isPowerBIConfigured,
  type PowerBICustomer,
} from "./powerbi";

const OVERRIDES = "ltp_overrides";
const ADDED = "ltp_added";

interface VenueLite {
  id: string;
  normName: string;
}

export interface SyncSummary {
  ok: boolean;
  configured: boolean;
  fetched: number;
  matched: number;
  matchedByName: number;
  flagged: number;
  pruned: number;
  unmatched: { name: string; postcode: string }[];
  error?: string;
}

// PostgREST caps reads at 1000 rows — page through so nothing is dropped.
async function selectAllRows<T>(table: string, cols: string): Promise<T[]> {
  const sb = supabaseAdmin();
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Venues asserted as customers by the seed import (public/seed-customers.json).
async function loadSeedCustomerIds(): Promise<Set<string>> {
  try {
    const file = path.join(process.cwd(), "public", "seed-customers.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { ids?: string[] };
    return new Set(parsed.ids ?? []);
  } catch {
    return new Set();
  }
}

function normPostcode(s: string): string {
  return (s || "").toUpperCase().replace(/\s+/g, "").trim();
}

function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|ltd|limited|plc|llp|llc|inc|co|uk)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Power BI names often carry an operator/group in parentheses ("SALT YARD
// BOROUGH (URBAN PUBS)") or the trading name inside them ("I DUE FRATELLI LTD
// (BENVENUTI)"). Match on the full name first, then the name without the
// parenthetical, then the parenthetical content itself.
function nameVariants(raw: string): string[] {
  const out = new Set<string>();
  const full = normName(raw);
  if (full) out.add(full);
  if (raw.includes("(")) {
    const outside = normName(raw.replace(/\([^)]*\)/g, " "));
    if (outside) out.add(outside);
    for (const grp of raw.match(/\([^)]+\)/g) ?? []) {
      const inside = normName(grp.slice(1, -1));
      if (inside && inside.length >= 4) out.add(inside);
    }
  }
  return Array.from(out);
}

// Best match within one postcode: exact normalised name > substring > token
// overlap. Postcode-scoping keeps false positives near zero across the UK set.
function matchVenue(nn: string, candidates: VenueLite[]): VenueLite | null {
  let best: VenueLite | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    let score = 0;
    if (c.normName === nn) {
      score = 1;
    } else if (nn.length >= 4 && (c.normName.includes(nn) || nn.includes(c.normName))) {
      score = 0.8;
    } else {
      const a = Array.from(new Set(nn.split(" ").filter(Boolean)));
      const b = Array.from(new Set(c.normName.split(" ").filter(Boolean)));
      if (a.length && b.length) {
        const bset = new Set(b);
        let inter = 0;
        for (const t of a) if (bset.has(t)) inter++;
        const jaccard = inter / (a.length + b.length - inter);
        if (jaccard >= 0.6) score = 0.5 + jaccard * 0.25;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore > 0 ? best : null;
}

interface VenueIndex {
  byPostcode: Map<string, VenueLite[]>;
  byExactName: Map<string, VenueLite[]>;
  byToken: Map<string, VenueLite[]>;
}

async function buildVenueIndex(): Promise<VenueIndex> {
  const byPostcode = new Map<string, VenueLite[]>();
  const byExactName = new Map<string, VenueLite[]>();
  const byToken = new Map<string, VenueLite[]>();
  const add = (id: string, name: string, postcode: string) => {
    const np = normPostcode(postcode);
    const nn = normName(name);
    if (!id || !nn) return;
    const entry = { id, normName: nn };
    if (np) {
      const arr = byPostcode.get(np);
      if (arr) arr.push(entry);
      else byPostcode.set(np, [entry]);
    }
    const ex = byExactName.get(nn);
    if (ex) ex.push(entry);
    else byExactName.set(nn, [entry]);
    for (const t of Array.from(new Set(nn.split(" ")))) {
      if (t.length < 3) continue;
      const arr = byToken.get(t);
      if (arr) arr.push(entry);
      else byToken.set(t, [entry]);
    }
  };

  // Base FSA dataset (Supabase Storage in prod, bundled file locally).
  const venues = await loadBaseVenues();
  for (const v of venues) add(v.id, v.name, v.postcode ?? "");

  // Manually-added venues from the shared DB, so they can match too.
  try {
    const rows = await selectAllRows<{ id: string; data: { id?: string; name?: string; postcode?: string } | null }>(ADDED, "id,data");
    for (const r of rows) {
      const d = r.data;
      if (d) add(d.id ?? r.id, d.name ?? "", d.postcode ?? "");
    }
  } catch {
    /* added venues are optional — base dataset is enough to match against */
  }

  return { byPostcode, byExactName, byToken };
}

// Last-resort match for customers whose Power BI postcode is a head office or
// foreign registered address (so postcode scoping can never hit). Links by
// name alone, but ONLY against venues already asserted to be customers (the
// seed import / manual flags) and ONLY when exactly one of them matches —
// so a stray same-named venue on the other side of the country never links.
const MAX_TOKEN_CANDIDATES = 400;

function matchByUniqueName(variants: string[], index: VenueIndex, knownCustomerIds: Set<string>): VenueLite | null {
  if (knownCustomerIds.size === 0) return null;
  for (const nn of variants) {
    if (nn.length < 6) continue;

    const exact = (index.byExactName.get(nn) ?? []).filter((c) => knownCustomerIds.has(c.id));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) continue; // several known customers share this name — unknowable

    // Substring containment either way. Candidates = union of the venue lists
    // for this name's usable tokens; tokens with huge lists are skipped, so a
    // name made only of common words never links.
    const tokens = Array.from(new Set(nn.split(" "))).filter((t) => t.length >= 3);
    const seen = new Set<string>();
    const hits: VenueLite[] = [];
    for (const t of tokens) {
      const list = index.byToken.get(t);
      if (!list || list.length > MAX_TOKEN_CANDIDATES) continue;
      for (const c of list) {
        if (!knownCustomerIds.has(c.id) || seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.normName.includes(nn) || (nn.includes(c.normName) && c.normName.length >= 6)) {
          hits.push(c);
          if (hits.length > 1) break;
        }
      }
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// Build the extra patch fields for the mobile "Contact info" panel from
// whichever Power BI contact columns are configured. Blank/missing fields are
// omitted (not written as empty strings) so a column that goes blank in Power
// BI doesn't clobber a previously-synced value — same additive philosophy as
// existingCustomer.
function contactPatch(c: PowerBICustomer | undefined): Record<string, unknown> {
  if (!c) return {};
  const patch: Record<string, unknown> = {};
  if (c.contactName) patch.customerContactName = c.contactName;
  if (c.phone) patch.customerContactPhone = c.phone;
  if (c.email) patch.customerContactEmail = c.email;
  if (c.accountManager) patch.customerAccountManager = c.accountManager;
  if (c.accountCode) patch.customerAccountCode = c.accountCode;
  return patch;
}

async function flagCustomers(ids: string[], contactById: Map<string, PowerBICustomer>): Promise<number> {
  if (!ids.length) return 0;
  const sb = supabaseAdmin();
  let flagged = 0;
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    // Merge with any existing override so we don't clobber other fields.
    const { data: existing, error: selErr } = await sb.from(OVERRIDES).select("id,patch").in("id", batch);
    if (selErr) throw selErr;
    const exMap = new Map((existing ?? []).map((r) => [r.id as string, r.patch as Record<string, unknown>]));
    const rows = batch.map((id) => ({
      id,
      patch: { ...(exMap.get(id) ?? {}), existingCustomer: true, ...contactPatch(contactById.get(id)) },
    }));
    const { error } = await sb.from(OVERRIDES).upsert(rows, { onConflict: "id" });
    if (error) throw error;
    flagged += rows.length;
  }
  return flagged;
}

// Remove sync-owned fields from overrides whose Power BI link is no longer
// produced by the current (stricter) matching — cleans up both mislinks from
// older sync logic and customers that left Power BI. Seed-asserted venues keep
// their existingCustomer flag (the seed import vouches for them); everything
// else the sync flagged is unflagged. Fields not owned by the sync (contact
// logs, exclusions, emails, ...) are always preserved.
async function pruneStaleLinks(
  allOverrides: Map<string, Record<string, unknown>>,
  matchedIds: Set<string>,
  seedIds: Set<string>
): Promise<number> {
  const SYNC_FIELDS = ["customerAccountCode", "customerAccountManager", "customerContactName", "customerContactPhone", "customerContactEmail"];
  const upserts: { id: string; patch: Record<string, unknown> }[] = [];
  const deletions: string[] = [];
  allOverrides.forEach((patch, id) => {
    if (!patch || !("customerAccountCode" in patch) || matchedIds.has(id)) return;
    const next = { ...patch };
    for (const f of SYNC_FIELDS) delete next[f];
    if (!seedIds.has(id)) delete next.existingCustomer;
    if (Object.keys(next).length === 0) deletions.push(id);
    else upserts.push({ id, patch: next });
  });

  const sb = supabaseAdmin();
  const CHUNK = 300;
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const { error } = await sb.from(OVERRIDES).upsert(upserts.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) throw error;
  }
  for (let i = 0; i < deletions.length; i += CHUNK) {
    const { error } = await sb.from(OVERRIDES).delete().in("id", deletions.slice(i, i + CHUNK));
    if (error) throw error;
  }
  return upserts.length + deletions.length;
}

// The prune step unlinks any account code that stops matching, so a sync
// against a stale dataset copy would strip every account created since that
// copy froze (the "LTP Sales Reps Dashboard" copy had its refresh disabled on
// 30 Nov 2025 and was missing 171 newer accounts when this guard was added).
// Prefer the dataset's refresh history; fall back to the newest fact date —
// facts can be dated a few days ahead (advance orders), so the fallback only
// catches long freezes.
const REFRESH_STALE_DAYS = 7; // live copies refresh ~3-hourly; a silent week means abandoned
const FACT_STALE_DAYS = 14;

async function datasetStaleReason(): Promise<string | null> {
  const refreshedAt = await getDatasetLastRefreshTime();
  if (refreshedAt) {
    const age = Date.now() - Date.parse(refreshedAt);
    if (Number.isFinite(age) && age > REFRESH_STALE_DAYS * 86_400_000) {
      return `dataset last refreshed ${refreshedAt.slice(0, 10)} — its scheduled refresh looks disabled; point POWERBI_DATASET_ID at a live copy`;
    }
    return null;
  }
  const factTable = (process.env.POWERBI_FACT_TABLE || process.env.POWERBI_CLIENT_TABLE || "F_DAILY").replace(/^"|"$/g, "");
  const dateCol = (process.env.POWERBI_DATE_COLUMN || "Date").replace(/^"|"$/g, "");
  try {
    const dax = `EVALUATE ROW("maxDate", MAX('${factTable.replace(/'/g, "''")}'[${dateCol.replace(/]/g, "]]")}]))`;
    const t = Date.parse(String((await executePowerBIDaxQuery(dax))[0]?.["maxDate"] ?? ""));
    if (Number.isNaN(t)) return null; // can't tell — don't block the sync on a heuristic
    if (Date.now() - t > FACT_STALE_DAYS * 86_400_000) {
      return `newest ${factTable} row is dated ${new Date(t).toISOString().slice(0, 10)} — dataset looks frozen; point POWERBI_DATASET_ID at a live copy`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function runCustomerSync(): Promise<SyncSummary> {
  const empty = { fetched: 0, matched: 0, matchedByName: 0, flagged: 0, pruned: 0, unmatched: [] as { name: string; postcode: string }[] };
  if (!isPowerBIConfigured()) {
    return { ok: false, configured: false, ...empty, error: "Power BI env vars are not set" };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, configured: false, ...empty, error: "Supabase (shared DB) is not configured" };
  }

  const staleReason = await datasetStaleReason();
  if (staleReason) {
    return { ok: false, configured: true, ...empty, error: `refusing to sync: ${staleReason}` };
  }

  const [customers, index, seedIds, overrideRows] = await Promise.all([
    fetchPowerBICustomers(),
    buildVenueIndex(),
    loadSeedCustomerIds(),
    selectAllRows<{ id: string; patch: Record<string, unknown> | null }>(OVERRIDES, "id,patch"),
  ]);

  const allOverrides = new Map<string, Record<string, unknown>>();
  for (const r of overrideRows) allOverrides.set(r.id, r.patch ?? {});

  // Venues we already believe are customers via a human-backed source: the
  // seed import or a manual flag (sync-written flags always carry an account
  // code, so they're excluded — a mislink must not vouch for itself).
  const knownCustomerIds = new Set(seedIds);
  allOverrides.forEach((patch, id) => {
    if (patch.existingCustomer === true && !patch.customerAccountCode) knownCustomerIds.add(id);
  });

  const matchedIds = new Set<string>();
  const contactById = new Map<string, PowerBICustomer>();
  const unmatched: { name: string; postcode: string }[] = [];
  let matchedByName = 0;
  for (const c of customers) {
    const variants = nameVariants(c.name);
    if (!variants.length) continue;
    const np = normPostcode(c.postcode);
    const candidates = np ? index.byPostcode.get(np) : undefined;
    let hit: VenueLite | null = null;
    if (candidates) {
      for (const nn of variants) {
        hit = matchVenue(nn, candidates);
        if (hit) break;
      }
    }
    if (!hit) {
      hit = matchByUniqueName(variants, index, knownCustomerIds);
      if (hit) matchedByName++;
    }
    if (hit) {
      matchedIds.add(hit.id);
      contactById.set(hit.id, c);
    } else {
      unmatched.push({ name: c.name, postcode: c.postcode });
    }
  }

  const flagged = await flagCustomers(Array.from(matchedIds), contactById);

  // Even with a fresh dataset, never mass-unlink: a partial or broken customer
  // fetch must not strip real links, so anything over 10% of linked venues is
  // treated as an upstream fault and pruning is skipped for this run.
  let linkedCount = 0;
  let wouldPrune = 0;
  allOverrides.forEach((patch, id) => {
    if (patch && "customerAccountCode" in patch) {
      linkedCount++;
      if (!matchedIds.has(id)) wouldPrune++;
    }
  });
  let pruned = 0;
  if (wouldPrune > Math.max(25, Math.ceil(linkedCount * 0.1))) {
    console.warn(`[powerbi-sync] prune skipped: run would unlink ${wouldPrune} of ${linkedCount} linked venues`);
  } else {
    pruned = await pruneStaleLinks(allOverrides, matchedIds, seedIds);
  }

  return {
    ok: true,
    configured: true,
    fetched: customers.length,
    matched: matchedIds.size,
    matchedByName,
    flagged,
    pruned,
    unmatched,
  };
}
