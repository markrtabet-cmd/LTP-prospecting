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
import type { Restaurant, SalesHistory, SalesMonthPoint, SalesProductPoint } from "./types";
import { PRODUCT_WINDOW_DAYS } from "./visits/config";
import { canonicalPostcode, geocodePostcodes, outwardCode } from "./geocode";
import { getRegion } from "./locations";
import { canonicalSector } from "./sectors";
import { cleanCustomerName, FIX_EDIT_OVERRIDE_FIELDS, type FixEdit, type UnmatchedCustomer, type UnmatchedReason, type VenueSuggestion } from "./customer-fix";
import { makeRestaurant } from "./mock-data";

const OVERRIDES = "ltp_overrides";
const ADDED = "ltp_added";
// The "customers to fix" list: Power BI customers the sync couldn't place, kept
// as a recomputed snapshot (one row per customer) plus two reserved rows: the
// human-dismissed account keys (an ignored customer stays ignored) and the
// fix-page "Edit details" corrections (re-applied to the raw values every run).
const UNMATCHED = "ltp_unmatched_customers";
const DISMISSED_ID = "__dismissed__";
const EDITS_ID = "__edits__";

interface VenueLite {
  id: string;
  normName: string;
  /** Display name + raw postcode, carried so the fix list can suggest venues. */
  name: string;
  postcode: string;
}

export interface SyncSummary {
  ok: boolean;
  configured: boolean;
  fetched: number;
  matched: number;
  matchedByName: number;
  flagged: number;
  pruned: number;
  /** Unmatched customers given their own map pin this run (see auto-place below). */
  autoPlaced: number;
  salesHistoryUpdated: number;
  unmatched: { name: string; postcode: string }[];
  /** How many unmatched customers are on the "customers to fix" list. */
  fixListSize: number;
  error?: string;
}

// Reserved-row helpers for the dismissed-account-codes set stored in UNMATCHED.
async function loadDismissedCodes(): Promise<Set<string>> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from(UNMATCHED).select("data").eq("id", DISMISSED_ID).maybeSingle();
    const codes = (data?.data as { codes?: string[] } | undefined)?.codes;
    return new Set(Array.isArray(codes) ? codes : []);
  } catch {
    return new Set();
  }
}

// Corrections saved on the fix page ("Edit details"), keyed by the customer's
// ORIGINAL natural key — an edited name/postcode would re-key a code-less
// account and orphan its entry. Re-applied to the raw Power BI rows every sync:
// the rebuild below is wholesale, so without this a saved edit would be
// reverted within the hour.
async function loadEditOverrides(): Promise<Map<string, FixEdit>> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from(UNMATCHED).select("data").eq("id", EDITS_ID).maybeSingle();
    const edits = (data?.data as { edits?: Record<string, FixEdit> } | undefined)?.edits;
    return new Map(Object.entries(edits && typeof edits === "object" ? edits : {}));
  } catch {
    return new Map();
  }
}

// Drop saved edits whose account has left Power BI entirely. Edits for MATCHED
// customers are kept — the edit may be the very reason they match (a corrected
// postcode is what ties the raw row to its auto-placed pin), so an entry lives
// as long as its account does. Re-reads the row fresh so an edit saved while
// this sync was running isn't clobbered by rewriting a stale copy.
async function pruneEditOverrides(liveKeys: Set<string>): Promise<void> {
  if (!liveKeys.size) return; // an empty customer pull must not wipe the edits
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from(UNMATCHED).select("data").eq("id", EDITS_ID).maybeSingle();
    const edits = (data?.data as { edits?: Record<string, FixEdit> } | undefined)?.edits ?? {};
    const stale = Object.keys(edits).filter((k) => !liveKeys.has(k));
    if (!stale.length) return;
    for (const k of stale) delete edits[k];
    const { error } = await sb.from(UNMATCHED).upsert({ id: EDITS_ID, data: { edits } }, { onConflict: "id" });
    if (error) throw error;
    console.log(`[powerbi-sync] pruned ${stale.length} orphaned fix-page edits`);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] fix-page edits not pruned: ${message.slice(0, 120)}`);
  }
}

// Account codes of manually-added customers (ltp_added rows carrying a Centric
// code). Unioned into the "live" set for pruneEditOverrides so an admin-added
// customer's saved edit (keyed by a Centric code that hasn't started syncing
// yet) is NOT pruned before the account first appears in the Power BI pull —
// otherwise the manual contact/sector would be lost by the time Centric returns
// it. See addCustomer in src/app/api/customers/manage/route.ts.
async function loadAddedAccountCodes(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await selectAllRows<{ id: string; data: { customerAccountCode?: string } | null }>(ADDED, "id,data");
    for (const r of rows) {
      const code = r.data?.customerAccountCode;
      if (typeof code === "string" && code.trim()) out.add(code.trim());
    }
  } catch {
    /* best-effort — worst case a just-added edit could prune, same as before */
  }
  return out;
}

// Replace the fix list wholesale with the current unmatched snapshot: upsert the
// live rows, then delete any older row that is no longer unmatched. The reserved
// rows (dismissed keys, saved edits) are never touched here. Best-effort — a
// missing table just logs a hint and leaves the rest of the sync intact.
async function persistUnmatched(rows: UnmatchedCustomer[]): Promise<void> {
  const sb = supabaseAdmin();
  try {
    const CHUNK = 300;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const upserts = rows.slice(i, i + CHUNK).map((r) => ({ id: r.id, data: r }));
      const { error } = await sb.from(UNMATCHED).upsert(upserts, { onConflict: "id" });
      if (error) throw error;
    }
    const keep = new Set(rows.map((r) => r.id));
    keep.add(DISMISSED_ID);
    keep.add(EDITS_ID);
    const existing = await selectAllRows<{ id: string }>(UNMATCHED, "id");
    const stale = existing.map((r) => r.id).filter((id) => !keep.has(id));
    for (let i = 0; i < stale.length; i += CHUNK) {
      const { error } = await sb.from(UNMATCHED).delete().in("id", stale.slice(i, i + CHUNK));
      if (error) throw error;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] fix list not saved (create table ${UNMATCHED}? see supabase-schema.sql): ${message.slice(0, 200)}`);
  }
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

// "restaurant(s)" is stripped alongside the legal-entity words below because
// Power BI often carries a customer's registered/legal name ("TORTELLO
// RESTAURANT LTD") while FSA lists its trading name ("Tortello") — without
// this, an exact-name match (see matchByGlobalExactName) can never fire for
// an otherwise-unambiguous customer.
function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|ltd|limited|plc|llp|llc|inc|co|uk|restaurants?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whole-word containment: is `inner` present as a run of COMPLETE words inside
// `outer`? Unlike a raw substring test, `" chelsea general store ".includes(" sea ")`
// is false — so a short venue token buried mid-word (the "sea" in "chelSEA") no
// longer counts as a name match, while "salt yard" still sits inside "salt yard
// borough". The old raw-substring check linked the customer CHELSEA GENERAL STORE
// to a seafood venue literally called "The Sea" (normalised to "sea"), because
// "chelsea general store" contains the letters "sea".
function wordRunContains(outer: string, inner: string): boolean {
  if (!inner) return false;
  return ` ${outer} `.includes(` ${inner} `);
}

// A confident name correspondence: identical, or one name wholly contains the
// other as WHOLE WORDS with the shorter (anchoring) name at least 4 chars — so a
// generic 3-letter token ("sea", "bar", "pub") can never anchor a link on its
// own. Used everywhere a match/suggestion asks "is one of these names inside the
// other?" so the substring-false-positive class is fixed in one place.
function nameContainsName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false;
  return wordRunContains(longer, shorter);
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
    } else if (nn.length >= 4 && nameContainsName(nn, c.normName)) {
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
  byDistrict: Map<string, VenueLite[]>;
  byExactName: Map<string, VenueLite[]>;
  byToken: Map<string, VenueLite[]>;
}

async function buildVenueIndex(): Promise<VenueIndex> {
  const byPostcode = new Map<string, VenueLite[]>();
  const byDistrict = new Map<string, VenueLite[]>();
  const byExactName = new Map<string, VenueLite[]>();
  const byToken = new Map<string, VenueLite[]>();
  const add = (id: string, name: string, postcode: string) => {
    const np = normPostcode(postcode);
    const nn = normName(name);
    if (!id || !nn) return;
    const entry: VenueLite = { id, normName: nn, name, postcode };
    if (np) {
      const arr = byPostcode.get(np);
      if (arr) arr.push(entry);
      else byPostcode.set(np, [entry]);
      const oc = outwardCode(postcode);
      if (oc) {
        const darr = byDistrict.get(oc);
        if (darr) darr.push(entry);
        else byDistrict.set(oc, [entry]);
      }
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

  return { byPostcode, byDistrict, byExactName, byToken };
}

// A district-scoped EXACT-name match: the same trading name in the same
// outward code (e.g. "SW1A"), used to link a customer whose Power BI postcode
// differs from the FSA venue's (a registered/head-office postcode) but is at
// least in the same district. Only fires when exactly one venue in the district
// has that normalised name — an ambiguous district is left for a human, so this
// can never silently link the wrong same-named venue.
function matchDistrictExact(variants: string[], candidates: VenueLite[]): VenueLite | null {
  for (const nn of variants) {
    if (nn.length < 4) continue;
    const exact = candidates.filter((c) => c.normName === nn);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null; // ambiguous — surface on the fix list instead
  }
  return null;
}

// Rough name similarity for RANKING fix-list suggestions (never for auto-links):
// 1 = identical, 0.85 = one contains the other, else Jaccard token overlap.
function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (nameContainsName(a, b)) return 0.85;
  const as = Array.from(new Set(a.split(" ").filter(Boolean)));
  const bs = new Set(b.split(" ").filter(Boolean));
  if (!as.length || !bs.size) return 0;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter++;
  return inter / (as.length + bs.size - inter);
}

// Up to three existing venues that could be this customer, best first — shown on
// the fix page so a human can link (avoiding a duplicate pin) with one tap.
// Candidates come from the same exact postcode plus same-district venues that
// share a name token; huge token lists are skipped so cost stays bounded.
const SUGGESTION_MIN_SCORE = 0.34;
const SUGGESTION_TOKEN_CAP = 600;

function buildSuggestions(name: string, postcode: string, index: VenueIndex): VenueSuggestion[] {
  const variants = nameVariants(name);
  if (!variants.length) return [];
  const oc = outwardCode(postcode);
  const np = normPostcode(postcode);
  const pool = new Map<string, VenueLite>();
  if (np) for (const v of index.byPostcode.get(np) ?? []) pool.set(v.id, v);
  const tokens = new Set<string>();
  for (const nn of variants) for (const t of nn.split(" ")) if (t.length >= 3) tokens.add(t);
  for (const t of Array.from(tokens)) {
    const list = index.byToken.get(t);
    if (!list || list.length > SUGGESTION_TOKEN_CAP) continue;
    for (const v of list) {
      if (pool.has(v.id)) continue;
      if (!oc || outwardCode(v.postcode) === oc) pool.set(v.id, v);
    }
  }
  const scored: { v: VenueLite; score: number }[] = [];
  for (const v of Array.from(pool.values())) {
    let best = 0;
    for (const nn of variants) best = Math.max(best, nameSimilarity(nn, v.normName));
    if (best >= SUGGESTION_MIN_SCORE) scored.push({ v, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(({ v }) => ({ venueId: v.id, name: v.name, postcode: v.postcode }));
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
        // Whole-word containment (not raw substring) so a short venue name buried
        // inside a customer word can't spuriously link — same guard as matchVenue.
        if (nameContainsName(nn, c.normName)) {
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

async function flagCustomers(
  ids: string[],
  contactById: Map<string, PowerBICustomer>,
  salesHistoryById: Map<string, SalesHistory>,
  sectorByCode: Map<string, string>,
  reasonByCode: Map<string, string>,
  statusByCode: Map<string, string>,
  groupByCode: Map<string, string>,
  editOverrides: Map<string, FixEdit>
): Promise<number> {
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
    const rows = batch.map((id) => {
      const history = salesHistoryById.get(id);
      const contact = contactById.get(id);
      const code = contact?.accountCode;
      const sector = code ? sectorByCode.get(code) : undefined;
      const reason = code ? reasonByCode.get(code) : undefined;
      const status = code ? statusByCode.get(code) : undefined;
      const group = code ? groupByCode.get(code) : undefined;
      // Admin "Edit customer" overrides (contact / sector) win over the Power BI
      // values so a profile completed by hand isn't reverted each sync. Keyed by
      // account code (edits on code-less accounts persist via the name/postcode
      // raw-row path only). name/postcode/address are handled up front.
      const edit = code ? editOverrides.get(code) : undefined;
      const editPatch: Record<string, unknown> = {};
      if (edit) {
        for (const { edit: ek, venue } of FIX_EDIT_OVERRIDE_FIELDS) {
          const v = edit[ek];
          if (typeof v === "string" && v.trim()) editPatch[venue] = v.trim();
        }
        if (edit.address !== undefined && edit.address.trim()) editPatch.address = edit.address.trim();
      }
      return {
        id,
        patch: {
          ...(exMap.get(id) ?? {}),
          existingCustomer: true,
          // Every customer displays its Power BI name/title (not the FSA trading
          // name), so the app matches what reps see in Power BI. Cleaned to drop
          // a leading status tag like "(INACTIVE) ".
          ...(contact?.name ? { name: cleanCustomerName(contact.name) } : {}),
          ...contactPatch(contact),
          ...(sector ? { sector } : {}),
          // Only own this field once the reason column is wired: then write it on
          // every sync (null when Power BI has blanked it) so a stale reason can't
          // linger and wrongly suppress the calendar's inactive nudge. Left
          // untouched while the feature is off.
          ...(FACT_INACTIVITY_REASON_COL ? { inactivityReason: reason ?? null } : {}),
          // Account status + owner group: written on every sync (null when Power
          // BI genuinely has none, clearing stale values). Guarded on the fetch
          // returning ANY rows — an empty map means the best-effort sub-query
          // failed/threw, and writing null across the board would wrongly wipe
          // every stored status/group (and, since status is the authoritative
          // inactive flag, silently flip inactive customers back to active) on a
          // single transient Power BI hiccup. Skip the write in that case so the
          // last good values survive to the next successful sync.
          ...(FACT_ACCOUNT_STATUS_COL && statusByCode.size > 0 ? { accountStatus: status ?? null } : {}),
          ...(FACT_OWNER_GROUP_COL && groupByCode.size > 0 ? { ownerGroup: group ?? null } : {}),
          ...(history ? { salesHistory: history } : {}),
          // Manual admin edits last, so they win over the Power BI values above.
          ...editPatch,
        },
      };
    });
    const { error } = await sb.from(OVERRIDES).upsert(rows, { onConflict: "id" });
    if (error) throw error;
    flagged += rows.length;
  }
  return flagged;
}

// ---- Sales-history (feeds the calendar's sales-health alerts) --------------
//
// One bulk DAX pull per sync — not one query per customer — grouped by the
// same Cust code join key the mobile Contact/Sales tab already uses (see
// src/app/api/powerbi/customer-insights/route.ts). Two shapes are pulled:
//   - monthly revenue+kg per customer, for the volume-drop / stopped-ordering
//     checks (src/lib/visits/sales-health.ts).
//   - per-product totals over two rolling windows (recent vs prior), for the
//     product-switch check.
// Column names default to the same values already proven against this
// dataset by the customer-insights route, so this needs no extra setup.

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim().replace(/^"|"$/g, "") : fallback;
}

const FACT_TABLE = envOr("POWERBI_FACT_TABLE", envOr("POWERBI_CLIENT_TABLE", "F_DAILY"));
const FACT_CODE_COL = envOr("POWERBI_FACT_CUSTOMER_CODE_COLUMN", "Cust code");
const FACT_DATE_COL = envOr("POWERBI_DATE_COLUMN", "Date");
const FACT_SALES_COL = envOr("POWERBI_VALUE_COLUMN", "Gross Sales");
const FACT_WEIGHT_COL = envOr("POWERBI_WEIGHT_COLUMN", "Net Weight");
const FACT_STOCK_CODE_COL = envOr("POWERBI_STOCK_CODE_COLUMN", "Stock Code");
const FACT_DESCRIPTION_COL = envOr("POWERBI_DESCRIPTION_COLUMN", "Description");
// The customer's sector / trade channel (F_DAILY[Market]) — "Hotels", "Delis",
// "Italian restaurant", etc. Configurable in case the column is renamed.
const FACT_MARKET_COL = envOr("POWERBI_SECTOR_COLUMN", "Market");
// The reason a customer is inactive, from Power BI. There's no confirmed column
// for this yet (the fact table only carries a coarse "Account Status"), so this
// is OFF until an admin points POWERBI_INACTIVITY_REASON_COLUMN at the real
// field — flip that one env var on and the reason flows to the Customers list
// and clears the calendar's "schedule a meeting" nudge. Assumed to live on the
// fact table (F_DAILY) keyed by customer code, like Market; set
// POWERBI_INACTIVITY_REASON_TABLE if it lives elsewhere.
const FACT_INACTIVITY_REASON_COL = (process.env.POWERBI_INACTIVITY_REASON_COLUMN || "").trim().replace(/^"|"$/g, "");
const INACTIVITY_REASON_TABLE = envOr("POWERBI_INACTIVITY_REASON_TABLE", FACT_TABLE);
// The customer's account lifecycle status (F_DAILY[Account Status]) — "Active" /
// "Closed" / "On Stop". This is the AUTHORITATIVE inactive flag: once synced, a
// status other than "Active" marks the customer inactive everywhere, replacing
// the sales-recency rule (see customerActivity() in src/lib/customer-activity.ts).
// ON by default because the column is confirmed present on the live dataset;
// point POWERBI_ACCOUNT_STATUS_COLUMN elsewhere or set it blank to disable.
const FACT_ACCOUNT_STATUS_COL = envOr("POWERBI_ACCOUNT_STATUS_COLUMN", "Account Status");
// The owner/operator group (F_DAILY[Customer Group]) — "SOHO HOUSE", "URBAN
// PUBS", … Venues sharing a real group value are run by the same people. ON by
// default (column confirmed present); set POWERBI_OWNER_GROUP_COLUMN blank to
// disable. "INDEPENDENT" / blank are treated as "no group" (see canonicalOwnerGroup).
const FACT_OWNER_GROUP_COL = envOr("POWERBI_OWNER_GROUP_COLUMN", "Customer Group");
// Group values that mean "not part of a group" — never treated as a real group.
const NON_GROUP_VALUES = new Set(["", "INDEPENDENT", "INDIVIDUAL", "N/A", "NONE", "-"]);

/** A Power BI Customer Group value, or "" when it means "no group". */
function canonicalOwnerGroup(raw: string): string {
  const s = rowStr(raw).replace(/\s+/g, " ").trim();
  return NON_GROUP_VALUES.has(s.toUpperCase()) ? "" : s;
}

// Latest non-blank sector per customer code, in one pull. Best-effort: any
// failure (column missing on this dataset) yields an empty map so the rest of
// the sync still runs — sector is a nice-to-have, never a matching dependency.
async function fetchSectorByCode(): Promise<Map<string, string>> {
  const dax = `EVALUATE ADDCOLUMNS(VALUES(${daxCol(FACT_TABLE, FACT_CODE_COL)}), "sector", CALCULATE(MAXX(TOPN(1, FILTER(${daxTable(FACT_TABLE)}, NOT ISBLANK(${daxCol(FACT_TABLE, FACT_MARKET_COL)})), ${daxCol(FACT_TABLE, FACT_DATE_COL)}, DESC), ${daxCol(FACT_TABLE, FACT_MARKET_COL)})))`;
  const out = new Map<string, string>();
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      const sector = canonicalSector(rowStr(r["sector"]));
      if (code && sector) out.set(code, sector);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] sector fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

// Latest non-blank inactivity reason per customer code, in one pull — the same
// shape as fetchSectorByCode. No-op (empty map) until POWERBI_INACTIVITY_REASON_COLUMN
// is set, and best-effort otherwise: a missing column / date on the configured
// table just yields an empty map so the rest of the sync runs unaffected.
async function fetchInactivityReasonByCode(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!FACT_INACTIVITY_REASON_COL) return out; // not wired up yet
  const codeCol = daxCol(INACTIVITY_REASON_TABLE, FACT_CODE_COL);
  const reasonCol = daxCol(INACTIVITY_REASON_TABLE, FACT_INACTIVITY_REASON_COL);
  const dateCol = daxCol(INACTIVITY_REASON_TABLE, FACT_DATE_COL);
  const dax = `EVALUATE ADDCOLUMNS(VALUES(${codeCol}), "reason", CALCULATE(MAXX(TOPN(1, FILTER(${daxTable(INACTIVITY_REASON_TABLE)}, NOT ISBLANK(${reasonCol})), ${dateCol}, DESC), ${reasonCol})))`;
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      const reason = rowStr(r["reason"]);
      if (code && reason) out.set(code, reason);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] inactivity-reason fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

// Latest non-blank account status per customer code, in one pull — same shape
// as fetchSectorByCode. Best-effort: a missing column just yields an empty map
// so the rest of the sync runs (activity then falls back to sales recency).
async function fetchAccountStatusByCode(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!FACT_ACCOUNT_STATUS_COL) return out; // disabled
  const codeCol = daxCol(FACT_TABLE, FACT_CODE_COL);
  const statusCol = daxCol(FACT_TABLE, FACT_ACCOUNT_STATUS_COL);
  const dateCol = daxCol(FACT_TABLE, FACT_DATE_COL);
  const dax = `EVALUATE ADDCOLUMNS(VALUES(${codeCol}), "status", CALCULATE(MAXX(TOPN(1, FILTER(${daxTable(FACT_TABLE)}, NOT ISBLANK(${statusCol})), ${dateCol}, DESC), ${statusCol})))`;
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      const status = rowStr(r["status"]);
      if (code && status) out.set(code, status);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] account-status fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

// Latest non-blank owner/operator group per customer code, in one pull. Blank /
// "INDEPENDENT" values are dropped by canonicalOwnerGroup so only real groups
// land in the map. Best-effort like the sector pull.
async function fetchOwnerGroupByCode(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!FACT_OWNER_GROUP_COL) return out; // disabled
  const codeCol = daxCol(FACT_TABLE, FACT_CODE_COL);
  const groupCol = daxCol(FACT_TABLE, FACT_OWNER_GROUP_COL);
  const dateCol = daxCol(FACT_TABLE, FACT_DATE_COL);
  const dax = `EVALUATE ADDCOLUMNS(VALUES(${codeCol}), "grp", CALCULATE(MAXX(TOPN(1, FILTER(${daxTable(FACT_TABLE)}, NOT ISBLANK(${groupCol})), ${dateCol}, DESC), ${groupCol})))`;
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      const group = canonicalOwnerGroup(rowStr(r["grp"]));
      if (code && group) out.set(code, group);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] owner-group fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

// Codes that ordered within the last ~3 months — drives the fix list's "active"
// flag (and its hide-inactive toggle) for customers with no synced sales
// history of their own. Best-effort, like the sector pull.
const ACTIVE_WITHIN_DAYS = 92; // ~3 months

async function fetchActiveCodes(): Promise<Set<string>> {
  const dax = `EVALUATE FILTER(ADDCOLUMNS(VALUES(${daxCol(FACT_TABLE, FACT_CODE_COL)}), "lastSale", CALCULATE(MAX(${daxCol(FACT_TABLE, FACT_DATE_COL)}))), [lastSale] >= TODAY() - ${ACTIVE_WITHIN_DAYS})`;
  const out = new Set<string>();
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      if (code) out.add(code);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] activity fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

function daxTable(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}
function daxCol(tableName: string, columnName: string): string {
  return `${daxTable(tableName)}[${columnName.replace(/]/g, "]]")}]`;
}
function rowNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function rowStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "(Blank)" ? "" : s;
}

// Grouped by customer + calendar year/month — mirrors the per-customer
// monthlyQuery in customer-insights/route.ts, just without the per-code FILTER.
function bulkMonthlySalesDax(): string {
  const dateCol = daxCol(FACT_TABLE, FACT_DATE_COL);
  return `EVALUATE
VAR Fact = FILTER(${daxTable(FACT_TABLE)}, ${dateCol} >= DATE(YEAR(TODAY()) - 1, 1, 1))
VAR WithYM = ADDCOLUMNS(Fact, "@y", YEAR(${dateCol}), "@m", MONTH(${dateCol}))
RETURN GROUPBY(
  WithYM, ${daxCol(FACT_TABLE, FACT_CODE_COL)}, [@y], [@m],
  "sales", SUMX(CURRENTGROUP(), ${daxCol(FACT_TABLE, FACT_SALES_COL)}),
  "kg", SUMX(CURRENTGROUP(), ${daxCol(FACT_TABLE, FACT_WEIGHT_COL)})
)`;
}

// Grouped by customer + product + a recent/prior bucket flag, so the whole
// book's product mix comes back in one query instead of one per customer.
function bulkProductWindowDax(): string {
  const dateCol = daxCol(FACT_TABLE, FACT_DATE_COL);
  return `EVALUATE
VAR RecentStart = TODAY() - ${PRODUCT_WINDOW_DAYS}
VAR PriorStart = TODAY() - ${PRODUCT_WINDOW_DAYS * 2}
VAR Fact = FILTER(${daxTable(FACT_TABLE)}, ${dateCol} >= PriorStart)
VAR WithBucket = ADDCOLUMNS(Fact, "@bucket", IF(${dateCol} >= RecentStart, "recent", "prior"))
RETURN GROUPBY(
  WithBucket, ${daxCol(FACT_TABLE, FACT_CODE_COL)}, ${daxCol(FACT_TABLE, FACT_STOCK_CODE_COL)}, ${daxCol(FACT_TABLE, FACT_DESCRIPTION_COL)}, [@bucket],
  "sales", SUMX(CURRENTGROUP(), ${daxCol(FACT_TABLE, FACT_SALES_COL)})
)`;
}

/** Bulk monthly sales for every customer code in one pull, newest last. */
async function fetchBulkMonthlySales(): Promise<Map<string, SalesMonthPoint[]>> {
  const rows = await executePowerBIDaxQuery(bulkMonthlySalesDax());
  const byCode = new Map<string, SalesMonthPoint[]>();
  for (const r of rows) {
    const code = rowStr(r[FACT_CODE_COL]);
    const y = rowNum(r["@y"]);
    const m = rowNum(r["@m"]);
    if (!code || !y || !m) continue;
    const arr = byCode.get(code) ?? [];
    arr.push({
      month: `${y}-${String(m).padStart(2, "0")}`,
      sales: rowNum(r["sales"]),
      kg: r["kg"] == null ? null : rowNum(r["kg"]),
    });
    byCode.set(code, arr);
  }
  byCode.forEach((arr) => arr.sort((a, b) => a.month.localeCompare(b.month)));
  return byCode;
}

/** Bulk per-product recent/prior totals for every customer code in one pull. */
async function fetchBulkProductWindows(): Promise<
  Map<string, { recent: SalesProductPoint[]; prior: SalesProductPoint[] }>
> {
  const rows = await executePowerBIDaxQuery(bulkProductWindowDax());
  const byCode = new Map<string, { recent: SalesProductPoint[]; prior: SalesProductPoint[] }>();
  for (const r of rows) {
    const code = rowStr(r[FACT_CODE_COL]);
    const bucket = rowStr(r["@bucket"]);
    const productCode = rowStr(r[FACT_STOCK_CODE_COL]);
    if (!code || !productCode || (bucket !== "recent" && bucket !== "prior")) continue;
    const entry = byCode.get(code) ?? { recent: [], prior: [] };
    entry[bucket].push({
      code: productCode,
      description: rowStr(r[FACT_DESCRIPTION_COL]) || productCode,
      sales: rowNum(r["sales"]),
    });
    byCode.set(code, entry);
  }
  return byCode;
}

// Distinct order dates per customer over ~30 weeks — enough to see even a
// bimonthly rhythm break. Feeds the order-cadence check (src/lib/visits/cadence.ts).
const ORDER_DATES_WINDOW_DAYS = 210;

function isoDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

async function fetchBulkOrderDates(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const dateCol = daxCol(FACT_TABLE, FACT_DATE_COL);
  const dax = `EVALUATE SUMMARIZE(FILTER(${daxTable(FACT_TABLE)}, ${dateCol} > TODAY() - ${ORDER_DATES_WINDOW_DAYS}), ${daxCol(FACT_TABLE, FACT_CODE_COL)}, ${dateCol})`;
  try {
    const rows = await executePowerBIDaxQuery(dax);
    for (const r of rows) {
      const code = rowStr(r[FACT_CODE_COL]);
      const iso = isoDay(r[FACT_DATE_COL]);
      if (!code || !iso) continue;
      const arr = out.get(code);
      if (arr) arr.push(iso);
      else out.set(code, [iso]);
    }
    out.forEach((arr) => arr.sort());
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] order-dates fetch skipped: ${message.slice(0, 160)}`);
  }
  return out;
}

// Cap how much monthly history rides each venue's JSONB — sales-health only
// needs a handful of months either side of its comparison windows.
const MONTHLY_HISTORY_MONTHS = 8;

/**
 * Sales-health snapshot per matched venue, keyed by venue id. Best-effort: if
 * either bulk query fails (e.g. the fact table/columns aren't configured for
 * this dataset), returns an empty map so the rest of the sync still runs —
 * matching/flagging a venue as a customer must never depend on this.
 */
async function buildSalesHistoryById(contactById: Map<string, PowerBICustomer>): Promise<Map<string, SalesHistory>> {
  const codeToVenueId = new Map<string, string>();
  contactById.forEach((c, venueId) => {
    if (c.accountCode) codeToVenueId.set(c.accountCode, venueId);
  });
  if (codeToVenueId.size === 0) return new Map();

  let monthlyByCode: Map<string, SalesMonthPoint[]>;
  let productsByCode: Map<string, { recent: SalesProductPoint[]; prior: SalesProductPoint[] }>;
  try {
    [monthlyByCode, productsByCode] = await Promise.all([fetchBulkMonthlySales(), fetchBulkProductWindows()]);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.warn(`[powerbi-sync] sales-history skipped: ${message.slice(0, 200)}`);
    return new Map();
  }
  // Order dates are best-effort — a failure here must not drop the sales history.
  const orderDatesByCode = await fetchBulkOrderDates();

  const syncedAt = new Date().toISOString();
  const out = new Map<string, SalesHistory>();
  codeToVenueId.forEach((venueId, code) => {
    const monthly = (monthlyByCode.get(code) ?? []).slice(-MONTHLY_HISTORY_MONTHS);
    const products = productsByCode.get(code) ?? { recent: [], prior: [] };
    out.set(venueId, {
      monthly,
      priorProducts: products.prior,
      recentProducts: products.recent,
      orderDates: orderDatesByCode.get(code) ?? [],
      syncedAt,
    });
  });
  return out;
}

// ---- Auto-place unmatched customers ----------------------------------------
//
// A Power BI customer only appears on the map by riding an FSA base venue. When
// the customer's premises simply isn't in the FSA data (an independent deli, a
// members' club, a market stall, a place trading under a different name), the
// automatic match legitimately finds nothing — and the customer was invisible,
// surfacing only on the admin "customers to fix" page. That lost real customers
// on the map (e.g. TRAFALGAR CHELSEA on the King's Road, or CHELSEA GENERAL
// STORE once we stopped mis-linking it to "The Sea").
//
// So for the confidently-unplaceable ones — geocoded cleanly AND no candidate
// venue looks like them ("no_match") — we synthesise their own customer pin from
// the Power BI record. Ambiguous customers (a candidate venue exists) stay on the
// human fix list, so we never auto-create a duplicate of an existing venue.
//
// The synthetic id is stable (account-code based, same scheme as the manual
// "Add" action) so re-runs are idempotent, and because buildVenueIndex indexes
// the added table, the NEXT sync simply matches the customer to this venue like
// any other — the placement is self-consistent, not a parallel code path.
function pbiVenueId(c: PowerBICustomer): string {
  const base = (c.accountCode || c.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base ? `pbi-${base}` : "";
}

// Which of these ids already exist in the shared added table — we only INSERT
// genuinely-new customer pins so a human's later edits (moved pin, contact log)
// are never clobbered; once a pin exists the normal matched flow keeps it fresh.
async function loadExistingAddedIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const sb = supabaseAdmin();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb.from(ADDED).select("id").in("id", ids.slice(i, i + CHUNK));
    if (error) throw error;
    for (const r of data ?? []) out.add((r as { id: string }).id);
  }
  return out;
}

interface PlaceEntry {
  customer: PowerBICustomer;
  row: UnmatchedCustomer;
  venueId: string;
}

// Insert a customer pin per entry into the shared added table. Sales history is
// baked in so a lapsed account (no order in 3+ months) shows grey/inactive the
// instant it lands, instead of a misleading blue "active".
async function placeCustomerVenues(
  entries: PlaceEntry[],
  salesHistoryById: Map<string, SalesHistory>,
  reasonByCode: Map<string, string>,
  statusByCode: Map<string, string>,
  groupByCode: Map<string, string>
): Promise<number> {
  if (!entries.length) return 0;
  const sb = supabaseAdmin();
  const rows = entries.map(({ customer: c, row, venueId }) => {
    // The customer's local area (borough / local authority). postcodes.io almost
    // always supplies it; if not, derive a broad area from the postcode so a
    // non-London customer is never mislabelled "London".
    const borough = row.district || (row.postcode ? getRegion("", row.postcode) : "London");
    const built: Restaurant = makeRestaurant({
      id: venueId,
      name: cleanCustomerName(c.name),
      address: row.address || borough || row.postcode,
      postcode: row.postcode,
      borough,
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      cuisineType: "Italian",
      businessType: "Customer account",
      priceTier: 3,
      email: c.email,
      phone: c.phone,
      existingCustomer: true,
    });
    // A customer is never a hidden "excluded" prospect, whatever its score.
    built.excluded = false;
    built.source = row.approximate
      ? "Power BI customer (auto-placed, approx. location)"
      : "Power BI customer (auto-placed)";
    if (c.contactName) built.customerContactName = c.contactName;
    if (c.phone) built.customerContactPhone = c.phone;
    if (c.email) built.customerContactEmail = c.email;
    if (c.accountManager) built.customerAccountManager = c.accountManager;
    if (c.accountCode) built.customerAccountCode = c.accountCode;
    if (row.sector) built.sector = row.sector;
    const history = salesHistoryById.get(venueId);
    if (history) built.salesHistory = history;
    if (FACT_INACTIVITY_REASON_COL && c.accountCode) {
      built.inactivityReason = reasonByCode.get(c.accountCode) ?? null;
    }
    // Guard on a non-empty map so a failed best-effort fetch doesn't stamp null
    // across every freshly-placed customer (see flagCustomers for the rationale).
    if (FACT_ACCOUNT_STATUS_COL && statusByCode.size > 0 && c.accountCode) {
      built.accountStatus = statusByCode.get(c.accountCode) ?? null;
    }
    if (FACT_OWNER_GROUP_COL && groupByCode.size > 0 && c.accountCode) {
      built.ownerGroup = groupByCode.get(c.accountCode) ?? null;
    }
    return { id: venueId, data: built };
  });
  const CHUNK = 300;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(ADDED).upsert(rows.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) throw error;
  }
  return rows.length;
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
  // Sync-owned fields written onto EVERY matched customer (incl. the Power BI
  // name, now applied to all customers) — removed when a link goes stale.
  const SYNC_FIELDS = ["customerAccountCode", "customerAccountManager", "customerContactName", "customerContactPhone", "customerContactEmail", "sector", "inactivityReason", "accountStatus", "ownerGroup", "name"];
  // A MANUAL link (customerLinkedManually) additionally grafts a possibly-
  // relocated position and won-status onto the BASE FSA venue. When such a link
  // is pruned these must be stripped too — otherwise the venue is left moved yet
  // no longer flagged a customer, a half-state that can never self-heal.
  const MANUAL_LINK_FIELDS = ["postcode", "latitude", "longitude", "borough", "customerLinkedManually", "excluded", "outreachStatus"];
  const upserts: { id: string; patch: Record<string, unknown> }[] = [];
  const deletions: string[] = [];
  allOverrides.forEach((patch, id) => {
    if (!patch || !("customerAccountCode" in patch) || matchedIds.has(id)) return;
    const next = { ...patch };
    for (const f of SYNC_FIELDS) delete next[f];
    if (next.customerLinkedManually) for (const f of MANUAL_LINK_FIELDS) delete next[f];
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
  const empty = {
    fetched: 0,
    matched: 0,
    matchedByName: 0,
    flagged: 0,
    pruned: 0,
    autoPlaced: 0,
    salesHistoryUpdated: 0,
    unmatched: [] as { name: string; postcode: string }[],
    fixListSize: 0,
  };
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

  const [rawCustomers, index, seedIds, overrideRows, dismissedCodes, editOverrides, sectorByCode, activeCodes, reasonByCode, statusByCode, groupByCode] = await Promise.all([
    fetchPowerBICustomers(),
    buildVenueIndex(),
    loadSeedCustomerIds(),
    selectAllRows<{ id: string; patch: Record<string, unknown> | null }>(OVERRIDES, "id,patch"),
    loadDismissedCodes(),
    loadEditOverrides(),
    fetchSectorByCode(),
    fetchActiveCodes(),
    fetchInactivityReasonByCode(),
    fetchAccountStatusByCode(),
    fetchOwnerGroupByCode(),
  ]);

  // A customer's natural key: account code when present, else name+postcode.
  const rawKey = (c: PowerBICustomer) => c.accountCode || `${normName(c.name)}|${normPostcode(c.postcode)}`;

  // Saved "Edit details" corrections are applied to the raw Power BI rows UP
  // FRONT, before the matching passes, so a corrected postcode/name both
  // matches venues — including the pbi- pin the auto-place below creates for it
  // — and geocodes cleanly on every rebuild. Patched copies remember their
  // ORIGINAL natural key: an edited name/postcode must not re-key a code-less
  // account, or its edit (and any dismissal) would be orphaned.
  const editedKeys = new Map<PowerBICustomer, string>();
  const customers = rawCustomers.map((c) => {
    const ov = editOverrides.get(rawKey(c));
    if (!ov || (ov.name === undefined && ov.postcode === undefined)) return c;
    const patched: PowerBICustomer = { ...c, name: ov.name ?? c.name, postcode: ov.postcode ?? c.postcode };
    editedKeys.set(patched, rawKey(c));
    return patched;
  });

  const allOverrides = new Map<string, Record<string, unknown>>();
  for (const r of overrideRows) allOverrides.set(r.id, r.patch ?? {});

  // Venues we already believe are customers via a human-backed source: the
  // seed import or a manual flag (sync-written flags always carry an account
  // code, so they're excluded — a mislink must not vouch for itself).
  const knownCustomerIds = new Set(seedIds);
  allOverrides.forEach((patch, id) => {
    if (patch.existingCustomer === true && !patch.customerAccountCode) knownCustomerIds.add(id);
  });

  // Human-confirmed links from the "customers to fix" page: an override carrying
  // customerLinkedManually maps that account code to the venue a person chose.
  // These are authoritative and re-applied every sync so the customer's contact
  // + sales always attach to the right venue and it never re-appears on the fix
  // list.
  const manualLinkByCode = new Map<string, string>();
  allOverrides.forEach((patch, id) => {
    const code = patch.customerAccountCode;
    if (patch.customerLinkedManually === true && typeof code === "string" && code) {
      manualLinkByCode.set(code, id);
    }
  });

  // Passes in descending strength so a stronger signal can never lose a venue to
  // a weaker one, regardless of Power BI's list order: manual link > postcode >
  // district-exact > name-only. A single-pass version once let a real customer
  // lose its correct link to an unrelated same-named venue elsewhere purely
  // because the wrong one came later in the loop.
  type Strength = "manual" | "postcode" | "district" | "name";
  const STRENGTH: Record<Strength, number> = { manual: 3, postcode: 2, district: 1, name: 0 };
  interface Claim {
    customer: PowerBICustomer;
    strength: Strength;
  }
  const claims = new Map<string, Claim>();
  // The natural key, always from the ORIGINAL Power BI values (see editedKeys).
  const custKey = (c: PowerBICustomer) => editedKeys.get(c) ?? rawKey(c);
  // Tracks which customers already have a claim across passes so later passes
  // skip them and the unmatched list only reflects customers no pass could place.
  const matchedCustomerKeys = new Set<string>();

  function claimVenue(venueId: string, c: PowerBICustomer, strength: Strength) {
    const existing = claims.get(venueId);
    if (existing && STRENGTH[existing.strength] >= STRENGTH[strength]) return;
    claims.set(venueId, { customer: c, strength });
    matchedCustomerKeys.add(custKey(c));
  }

  // Pass 0: human-confirmed manual links win over everything.
  for (const c of customers) {
    if (!c.accountCode) continue;
    const venueId = manualLinkByCode.get(c.accountCode);
    if (venueId) claimVenue(venueId, c, "manual");
  }

  // Pass 1: postcode-scoped matches — the strong automatic signal.
  for (const c of customers) {
    if (matchedCustomerKeys.has(custKey(c))) continue;
    const variants = nameVariants(c.name);
    if (!variants.length) continue;
    const np = normPostcode(c.postcode);
    const candidates = np ? index.byPostcode.get(np) : undefined;
    if (!candidates) continue;
    let hit: VenueLite | null = null;
    for (const nn of variants) {
      hit = matchVenue(nn, candidates);
      if (hit) break;
    }
    if (hit) claimVenue(hit.id, c, "postcode");
  }

  // Pass 1.5: district-scoped EXACT-name match — links a customer whose Power BI
  // postcode differs from the venue's (registered/head-office address) but sits
  // in the same outward code, and only when the name is unambiguous there.
  for (const c of customers) {
    if (matchedCustomerKeys.has(custKey(c))) continue;
    const variants = nameVariants(c.name);
    if (!variants.length) continue;
    const oc = outwardCode(c.postcode);
    const candidates = oc ? index.byDistrict.get(oc) : undefined;
    if (!candidates) continue;
    const hit = matchDistrictExact(variants, candidates);
    if (hit && !claims.has(hit.id)) claimVenue(hit.id, c, "district");
  }

  // Pass 1.6: same-postcode SIMILAR-name auto-link. A shared full postcode is a
  // strong signal, so a customer whose name is clearly similar to a single
  // free venue in that exact postcode is linked automatically (the reps' "La
  // Tagliata" case), provided the choice is unambiguous and the venue isn't
  // already taken by a stronger/earlier claim.
  for (const c of customers) {
    if (matchedCustomerKeys.has(custKey(c))) continue;
    const variants = nameVariants(c.name);
    if (!variants.length) continue;
    const np = normPostcode(c.postcode);
    const candidates = np ? index.byPostcode.get(np) : undefined;
    if (!candidates) continue;
    const strong = candidates.filter(
      (v) => !claims.has(v.id) && variants.some((nn) => nameSimilarity(nn, v.normName) >= 0.5),
    );
    if (strong.length === 1) claimVenue(strong[0].id, c, "postcode");
  }

  // Pass 2: name-only fallback restricted to already-known customers (seed
  // import / manual flags) — for customers with no postcode match of their
  // own, and only allowed to claim a venue nobody stronger already has.
  for (const c of customers) {
    if (matchedCustomerKeys.has(custKey(c))) continue;
    const variants = nameVariants(c.name);
    if (!variants.length) continue;
    const hit = matchByUniqueName(variants, index, knownCustomerIds);
    if (!hit || claims.has(hit.id)) continue;
    claimVenue(hit.id, c, "name");
  }

  const matchedIds = new Set(claims.keys());
  const contactById = new Map<string, PowerBICustomer>();
  let matchedByName = 0;
  claims.forEach(({ customer, strength }, venueId) => {
    contactById.set(venueId, customer);
    if (strength === "name") matchedByName++;
  });

  // Venue ids that already represent a customer on the map: matched this run,
  // human/seed-asserted, or flagged by any prior override. Used to suppress
  // DUPLICATE Power BI accounts for a venue already covered — e.g. a legacy
  // "LA TAGLIATA CITY" account whose venue "La Tagliata" is already a customer
  // under another code. Re-linking would just overwrite the live account, so we
  // treat these as already handled rather than list them for a human.
  const customerVenueIds = new Set<string>(matchedIds);
  knownCustomerIds.forEach((id) => customerVenueIds.add(id));
  allOverrides.forEach((patch, id) => {
    if (patch.existingCustomer === true) customerVenueIds.add(id);
  });
  function coveredByExistingCustomer(c: PowerBICustomer): boolean {
    const np = normPostcode(c.postcode);
    if (!np) return false;
    const cands = index.byPostcode.get(np);
    if (!cands) return false;
    const variants = nameVariants(c.name);
    for (const v of cands) {
      if (!customerVenueIds.has(v.id)) continue;
      for (const nn of variants) if (nameSimilarity(nn, v.normName) >= 0.5) return true;
    }
    return false;
  }

  // Customers no pass could place, minus any a human dismissed and any already
  // covered by an existing customer venue. Deduped by natural key so the same
  // customer can't appear twice on the fix list.
  const unmatchedCustomers: PowerBICustomer[] = [];
  const seenUnmatched = new Set<string>();
  let coveredCount = 0;
  for (const c of customers) {
    const key = custKey(c);
    if (matchedCustomerKeys.has(key)) continue;
    if (dismissedCodes.has(key)) continue; // a human chose to ignore this one
    if (seenUnmatched.has(key)) continue;
    if (coveredByExistingCustomer(c)) { coveredCount++; continue; }
    seenUnmatched.add(key);
    unmatchedCustomers.push(c);
  }
  if (coveredCount) console.log(`[powerbi-sync] ${coveredCount} duplicate accounts hidden (venue already a customer)`);

  // Build the "customers to fix" list: geocode each unmatched postcode so it can
  // still be placed on the map, attach up to three suggested existing venues, and
  // classify why it didn't match. Kept paired with its Power BI customer so the
  // confidently-new ones can be auto-placed below.
  const geo = await geocodePostcodes(unmatchedCustomers.map((c) => c.postcode));
  const syncedAt = new Date().toISOString();
  const fixEntries = unmatchedCustomers.map((c) => {
    const g = c.postcode.trim() ? geo.get(canonicalPostcode(c.postcode)) : undefined;
    const suggestions: VenueSuggestion[] = buildSuggestions(c.name, c.postcode, index);
    let reason: UnmatchedReason;
    if (!c.postcode.trim()) reason = "no_postcode";
    else if (suggestions.length) reason = "ambiguous";
    else if (!g) reason = "postcode_unresolved";
    else reason = "no_match";
    const row: UnmatchedCustomer = {
      id: `fix_${custKey(c)}`,
      name: c.name,
      postcode: c.postcode,
      address: editOverrides.get(custKey(c))?.address || undefined,
      accountCode: c.accountCode,
      contactName: c.contactName,
      phone: c.phone,
      email: c.email,
      accountManager: c.accountManager,
      sector: c.accountCode ? sectorByCode.get(c.accountCode) : undefined,
      active: c.accountCode ? activeCodes.has(c.accountCode) : undefined,
      latitude: g?.latitude,
      longitude: g?.longitude,
      district: g?.district,
      approximate: g?.approximate,
      reason,
      suggestions,
      syncedAt,
    };
    return { customer: c, row };
  });

  // Auto-place the confidently-unplaceable customers (geocoded, no candidate
  // venue) as their own pins — but only ids not already in the added table, so a
  // human's edits to an existing pin are never clobbered.
  const placeable: PlaceEntry[] = fixEntries
    .filter((e) => e.row.reason === "no_match" && e.row.latitude != null && e.row.longitude != null)
    .map((e) => ({ customer: e.customer, row: e.row, venueId: pbiVenueId(e.customer) }))
    .filter((e) => e.venueId);
  const existingAddedIds = await loadExistingAddedIds(placeable.map((e) => e.venueId));
  const toPlace = placeable.filter((e) => !existingAddedIds.has(e.venueId));
  // Fold the about-to-be-placed customers into the sales-history pull (keyed by
  // their synthetic venue id) so a lapsed one shows grey/inactive immediately.
  for (const e of toPlace) contactById.set(e.venueId, e.customer);

  const salesHistoryById = await buildSalesHistoryById(contactById);
  const autoPlaced = await placeCustomerVenues(toPlace, salesHistoryById, reasonByCode, statusByCode, groupByCode);
  if (autoPlaced) console.log(`[powerbi-sync] auto-placed ${autoPlaced} unmatched customers on the map`);

  // Persist the fix list WITHOUT the ones we just placed — they're on the map
  // now, and the next sync will match them to their new pin like any other venue.
  const placedFixIds = new Set(toPlace.map((e) => e.row.id));
  const remainingFixRows = fixEntries.map((e) => e.row).filter((r) => !placedFixIds.has(r.id));
  await persistUnmatched(remainingFixRows);
  const addedCodes = await loadAddedAccountCodes();
  await pruneEditOverrides(new Set([...customers.map(custKey), ...Array.from(addedCodes)]));
  const unmatched = remainingFixRows.map((r) => ({ name: r.name, postcode: r.postcode }));

  const flagged = await flagCustomers(Array.from(matchedIds), contactById, salesHistoryById, sectorByCode, reasonByCode, statusByCode, groupByCode, editOverrides);

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
    autoPlaced,
    salesHistoryUpdated: salesHistoryById.size,
    unmatched,
    fixListSize: remainingFixRows.length,
  };
}
