import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { makeRestaurant } from "@/lib/mock-data";
import { geocodePostcodes, canonicalPostcode } from "@/lib/geocode";
import { cleanCustomerName, type FixEdit, type UnmatchedCustomer } from "@/lib/customer-fix";
import type { Restaurant } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNMATCHED = "ltp_unmatched_customers";
const OVERRIDES = "ltp_overrides";
const ADDED = "ltp_added";
const DISMISSED_ID = "__dismissed__";
const EDITS_ID = "__edits__";
// Reserved bookkeeping rows living alongside the fix rows in UNMATCHED.
const RESERVED_IDS = new Set([DISMISSED_ID, EDITS_ID]);

async function session() {
  const value = cookies().get(SESSION_COOKIE)?.value;
  return verifySessionValue(value);
}

// Only admins/developers resolve the fix list — it writes shared team data.
function canEdit(role: string | undefined): boolean {
  return role === "admin" || role === "developer";
}

// GET — the current fix list (reserved rows excluded).
export async function GET() {
  const s = await session();
  if (!s) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: true, items: [], configured: false });

  const sb = supabaseAdmin();
  const { data, error } = await sb.from(UNMATCHED).select("id,data");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const items = (data ?? [])
    .filter((r) => !RESERVED_IDS.has(r.id))
    .map((r) => r.data as UnmatchedCustomer)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, items, canEdit: canEdit(s.role) });
}

async function loadFixRow(id: string): Promise<UnmatchedCustomer | null> {
  const sb = supabaseAdmin();
  const { data } = await sb.from(UNMATCHED).select("data").eq("id", id).maybeSingle();
  return (data?.data as UnmatchedCustomer | undefined) ?? null;
}

async function deleteFixRow(id: string): Promise<void> {
  await supabaseAdmin().from(UNMATCHED).delete().eq("id", id);
}

// The customer-panel fields we sync from Power BI, mirrored onto a linked venue
// so the mobile Contact tab shows them.
function contactPatch(c: UnmatchedCustomer): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (c.contactName) p.customerContactName = c.contactName;
  if (c.phone) p.customerContactPhone = c.phone;
  if (c.email) p.customerContactEmail = c.email;
  if (c.accountManager) p.customerAccountManager = c.accountManager;
  if (c.accountCode) p.customerAccountCode = c.accountCode;
  if (c.sector) p.sector = c.sector;
  return p;
}

// Link an unmatched customer to an existing venue: flag it as a customer and
// mark the link human-confirmed so the nightly sync re-applies it (attaching
// contact + sales) and never lists this customer again. The venue always takes
// the customer's Power BI name/title. Its location is kept from the existing
// venue by default, or replaced with the Power BI postcode's when the rep asks
// (usePowerBILocation) — useful when the FSA record sits at the wrong spot.
async function linkToVenue(row: UnmatchedCustomer, venueId: string, usePowerBILocation: boolean) {
  const sb = supabaseAdmin();
  const { data: existing } = await sb.from(OVERRIDES).select("patch").eq("id", venueId).maybeSingle();
  const patch: Record<string, unknown> = {
    ...((existing?.patch as Record<string, unknown>) ?? {}),
    existingCustomer: true,
    customerLinkedManually: true,
    // A customer is never a hidden "excluded" prospect, and counts as won.
    excluded: false,
    outreachStatus: "converted",
    // Keep the Power BI name/title on the linked venue.
    name: cleanCustomerName(row.name),
    ...contactPatch(row),
  };

  if (usePowerBILocation) {
    let lat = row.latitude;
    let lng = row.longitude;
    let district = row.district;
    if ((lat == null || lng == null) && row.postcode) {
      const g = (await geocodePostcodes([row.postcode])).get(canonicalPostcode(row.postcode));
      if (g) { lat = g.latitude; lng = g.longitude; district = district || g.district; }
    }
    // Only override location when we actually resolved coordinates — otherwise
    // silently keep the existing venue's position rather than move it to (0,0).
    if (lat != null && lng != null) {
      patch.latitude = lat;
      patch.longitude = lng;
      if (row.postcode) patch.postcode = row.postcode;
      if (district) patch.borough = district;
    }
  }

  const { error } = await sb.from(OVERRIDES).upsert({ id: venueId, patch }, { onConflict: "id" });
  if (error) throw error;
  await deleteFixRow(row.id);
}

// Add an unmatched customer as a brand-new customer venue on the map. Uses the
// coordinates already geocoded during the sync, or a freshly geocoded/corrected
// postcode supplied by the fix page.
async function addAsVenue(row: UnmatchedCustomer, override: { latitude?: number; longitude?: number; postcode?: string; borough?: string; businessType?: string; name?: string; address?: string }) {
  const postcode = (override.postcode || row.postcode || "").trim();
  // When the admin edited the postcode, ignore the row's stale coordinates and
  // borough so we RE-GEOCODE the corrected postcode instead of pinning the new
  // postcode text on the old spot. (Before this, an edited postcode kept the
  // original coordinates.)
  const postcodeChanged =
    Boolean(override.postcode) &&
    canonicalPostcode(override.postcode!) !== canonicalPostcode(row.postcode || "");
  let lat = override.latitude ?? (postcodeChanged ? undefined : row.latitude);
  let lng = override.longitude ?? (postcodeChanged ? undefined : row.longitude);
  let borough = override.borough || (postcodeChanged ? "" : row.district || "");

  // If we still have no coordinates but a postcode, try to geocode it now.
  if ((lat == null || lng == null) && postcode) {
    const geo = await geocodePostcodes([postcode]);
    const g = geo.get(canonicalPostcode(postcode));
    if (g) {
      lat = g.latitude;
      lng = g.longitude;
      if (!borough) borough = g.district ?? "";
    }
  }
  if (lat == null || lng == null) {
    throw new Error("no-location");
  }

  const name = override.name?.trim() || cleanCustomerName(row.name);
  const slug = (row.accountCode || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  // Prefer the address typed in this request; a body that omits it falls back to
  // one saved earlier via "Edit details" (an explicit empty string clears it).
  const address = (override.address ?? row.address ?? "").trim();
  const built: Restaurant = makeRestaurant({
    id: `pbi-${slug || Math.random().toString(36).slice(2, 9)}`,
    name,
    address: address || borough || postcode,
    postcode,
    borough: borough || "London",
    latitude: lat,
    longitude: lng,
    cuisineType: "Italian",
    businessType: override.businessType || "Customer account",
    priceTier: 3,
    email: row.email,
    phone: row.phone,
    existingCustomer: true,
  });
  // A customer is never a "prospect to exclude", whatever its cuisine scores.
  built.excluded = false;
  built.source = "Power BI customer (added)";
  if (row.contactName) built.customerContactName = row.contactName;
  if (row.phone) built.customerContactPhone = row.phone;
  if (row.email) built.customerContactEmail = row.email;
  if (row.accountManager) built.customerAccountManager = row.accountManager;
  if (row.accountCode) built.customerAccountCode = row.accountCode;
  if (row.sector) built.sector = row.sector;

  const { error } = await supabaseAdmin().from(ADDED).upsert({ id: built.id, data: built }, { onConflict: "id" });
  if (error) throw error;
  await deleteFixRow(row.id);
  return built.id;
}

// The reserved edits row: corrections saved via "Edit details", keyed by the
// customer's ORIGINAL key — account code, else the row id minus "fix_". The
// hourly sync rebuilds the fix list wholesale from Power BI, so it re-applies
// these to the raw values every run; without them a saved edit would be
// reverted within the hour. The key must stay the pre-edit one: a code-less
// account's natural key is name|postcode, so keying by edited values would
// orphan the edit.
function editKey(row: UnmatchedCustomer): string {
  return row.accountCode || row.id.replace(/^fix_/, "");
}

async function loadEdits(): Promise<Record<string, FixEdit>> {
  const sb = supabaseAdmin();
  const { data } = await sb.from(UNMATCHED).select("data").eq("id", EDITS_ID).maybeSingle();
  const edits = (data?.data as { edits?: Record<string, FixEdit> } | undefined)?.edits;
  return edits && typeof edits === "object" ? edits : {};
}

// Merge a correction into the reserved edits row (a partial patch keeps earlier
// saved fields — e.g. a name fix must not lose a previously saved postcode).
async function saveEditOverride(row: UnmatchedCustomer, patch: FixEdit): Promise<void> {
  if (patch.name === undefined && patch.postcode === undefined && patch.address === undefined) return;
  const edits = await loadEdits();
  const key = editKey(row);
  edits[key] = { ...edits[key], ...patch };
  const { error } = await supabaseAdmin().from(UNMATCHED).upsert({ id: EDITS_ID, data: { edits } }, { onConflict: "id" });
  if (error) throw error;
}

// Drop a resolved row's saved edit. Best-effort: the action that resolved the
// row already succeeded, and the sync prunes orphaned entries anyway.
async function pruneEditOverride(row: UnmatchedCustomer): Promise<void> {
  try {
    const edits = await loadEdits();
    const key = editKey(row);
    if (!(key in edits)) return;
    delete edits[key];
    await supabaseAdmin().from(UNMATCHED).upsert({ id: EDITS_ID, data: { edits } }, { onConflict: "id" });
  } catch {
    /* stale entries are cleaned up by the sync */
  }
}

// Save corrected details as a first-class edit: update the fix row in place and
// remember the correction in the reserved edits row so it survives the hourly
// rebuild. An edited postcode is re-geocoded and the reason re-derived with the
// sync's ladder; suggestions are only refreshed by the next sync run (the venue
// index lives there).
async function editFixRow(row: UnmatchedCustomer, edit: FixEdit): Promise<UnmatchedCustomer> {
  const updated: UnmatchedCustomer = { ...row };
  const name = edit.name?.trim();
  if (name) updated.name = name;
  if (edit.address !== undefined) updated.address = edit.address.trim() || undefined;

  const postcode = edit.postcode?.trim();
  if (postcode !== undefined) {
    updated.postcode = postcode;
    if (canonicalPostcode(postcode) !== canonicalPostcode(row.postcode || "")) {
      const g = postcode ? (await geocodePostcodes([postcode])).get(canonicalPostcode(postcode)) : undefined;
      updated.latitude = g?.latitude;
      updated.longitude = g?.longitude;
      updated.district = g?.district;
      updated.approximate = g?.approximate;
      if (!postcode) updated.reason = "no_postcode";
      else if (updated.suggestions.length) updated.reason = "ambiguous";
      else if (!g) updated.reason = "postcode_unresolved";
      else updated.reason = "no_match";
    }
  }

  const { error } = await supabaseAdmin().from(UNMATCHED).upsert({ id: row.id, data: updated }, { onConflict: "id" });
  if (error) throw error;

  const patch: FixEdit = {};
  if (name) patch.name = name;
  if (postcode !== undefined) patch.postcode = postcode;
  if (edit.address !== undefined) patch.address = edit.address.trim();
  await saveEditOverride(row, patch);
  return updated;
}

// Ignore a customer: remember its key in the reserved dismissed row so the sync
// stops re-listing it, then drop it from the list.
async function dismiss(row: UnmatchedCustomer) {
  const sb = supabaseAdmin();
  const key = row.accountCode || row.id.replace(/^fix_/, "");
  const { data } = await sb.from(UNMATCHED).select("data").eq("id", DISMISSED_ID).maybeSingle();
  const codes: string[] = Array.isArray((data?.data as { codes?: string[] } | undefined)?.codes)
    ? ((data!.data as { codes: string[] }).codes)
    : [];
  if (!codes.includes(key)) codes.push(key);
  const { error } = await sb.from(UNMATCHED).upsert({ id: DISMISSED_ID, data: { codes } }, { onConflict: "id" });
  if (error) throw error;
  await deleteFixRow(row.id);
}

export async function POST(req: Request) {
  const s = await session();
  if (!s) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canEdit(s.role)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, error: "shared DB not configured" }, { status: 400 });

  let body: { action?: string; id?: string; venueId?: string; latitude?: number; longitude?: number; postcode?: string; borough?: string; businessType?: string; name?: string; address?: string; locationSource?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const { action, id } = body;
  if (!id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  if (RESERVED_IDS.has(id)) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });

  const row = await loadFixRow(id);
  if (!row) return NextResponse.json({ ok: false, error: "not found (already resolved?)" }, { status: 404 });

  try {
    if (action === "link") {
      if (!body.venueId) return NextResponse.json({ ok: false, error: "missing venueId" }, { status: 400 });
      await linkToVenue(row, body.venueId, body.locationSource === "powerbi");
      // KEEP any saved edit: flagCustomers rewrites the linked venue's name
      // from the raw Power BI row every sync, so a saved name correction must
      // keep being re-applied pre-match or it reverts within the hour. The
      // sync's pruneEditOverrides drops the entry once the account leaves
      // Power BI.
      return NextResponse.json({ ok: true });
    }
    if (action === "add") {
      const venueId = await addAsVenue(row, body);
      // Persist inline name/postcode corrections (and KEEP any saved earlier):
      // the pin took the corrected values, so the sync only keeps matching the
      // raw Power BI row to it if the correction is re-applied every run.
      const patch: FixEdit = {};
      if (body.name?.trim() && body.name.trim() !== row.name) patch.name = body.name.trim();
      if (body.postcode?.trim() && canonicalPostcode(body.postcode) !== canonicalPostcode(row.postcode || "")) patch.postcode = body.postcode.trim();
      await saveEditOverride(row, patch);
      return NextResponse.json({ ok: true, venueId });
    }
    if (action === "edit") {
      const item = await editFixRow(row, { name: body.name, postcode: body.postcode, address: body.address });
      return NextResponse.json({ ok: true, item });
    }
    if (action === "dismiss") {
      await dismiss(row);
      await pruneEditOverride(row);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    const status = message === "no-location" ? 422 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
