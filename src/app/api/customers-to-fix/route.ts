import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { makeRestaurant } from "@/lib/mock-data";
import { geocodePostcodes, canonicalPostcode } from "@/lib/geocode";
import type { UnmatchedCustomer } from "@/lib/customer-fix";
import type { Restaurant } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNMATCHED = "ltp_unmatched_customers";
const OVERRIDES = "ltp_overrides";
const ADDED = "ltp_added";
const DISMISSED_ID = "__dismissed__";

async function session() {
  const value = cookies().get(SESSION_COOKIE)?.value;
  return verifySessionValue(value);
}

// Only admins/developers resolve the fix list — it writes shared team data.
function canEdit(role: string | undefined): boolean {
  return role === "admin" || role === "developer";
}

// GET — the current fix list (reserved dismissed row excluded).
export async function GET() {
  const s = await session();
  if (!s) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: true, items: [], configured: false });

  const sb = supabaseAdmin();
  const { data, error } = await sb.from(UNMATCHED).select("id,data");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const items = (data ?? [])
    .filter((r) => r.id !== DISMISSED_ID)
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
// contact + sales) and never lists this customer again.
async function linkToVenue(row: UnmatchedCustomer, venueId: string) {
  const sb = supabaseAdmin();
  const { data: existing } = await sb.from(OVERRIDES).select("patch").eq("id", venueId).maybeSingle();
  const patch = {
    ...((existing?.patch as Record<string, unknown>) ?? {}),
    existingCustomer: true,
    customerLinkedManually: true,
    // A customer is never a hidden "excluded" prospect, and counts as won.
    excluded: false,
    outreachStatus: "converted",
    ...contactPatch(row),
  };
  const { error } = await sb.from(OVERRIDES).upsert({ id: venueId, patch }, { onConflict: "id" });
  if (error) throw error;
  await deleteFixRow(row.id);
}

// Add an unmatched customer as a brand-new customer venue on the map. Uses the
// coordinates already geocoded during the sync, or a freshly geocoded/corrected
// postcode supplied by the fix page.
async function addAsVenue(row: UnmatchedCustomer, override: { latitude?: number; longitude?: number; postcode?: string; borough?: string; businessType?: string }) {
  let lat = override.latitude ?? row.latitude;
  let lng = override.longitude ?? row.longitude;
  const postcode = (override.postcode || row.postcode || "").trim();
  let borough = override.borough || row.district || "";

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

  const slug = (row.accountCode || row.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const built: Restaurant = makeRestaurant({
    id: `pbi-${slug || Math.random().toString(36).slice(2, 9)}`,
    name: row.name,
    address: borough || postcode,
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

  let body: { action?: string; id?: string; venueId?: string; latitude?: number; longitude?: number; postcode?: string; borough?: string; businessType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const { action, id } = body;
  if (!id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });

  const row = await loadFixRow(id);
  if (!row) return NextResponse.json({ ok: false, error: "not found (already resolved?)" }, { status: 404 });

  try {
    if (action === "link") {
      if (!body.venueId) return NextResponse.json({ ok: false, error: "missing venueId" }, { status: 400 });
      await linkToVenue(row, body.venueId);
      return NextResponse.json({ ok: true });
    }
    if (action === "add") {
      const venueId = await addAsVenue(row, body);
      return NextResponse.json({ ok: true, venueId });
    }
    if (action === "dismiss") {
      await dismiss(row);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    const status = message === "no-location" ? 422 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
