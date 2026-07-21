// Admin add / edit customer. Power BI (Centric) is the read-only source of
// truth, and the nightly sync rewrites customer fields — so a manual edit only
// sticks if the sync re-applies it. We therefore do BOTH: write the change to
// the shared blob now (so it shows immediately) AND record it as a FixEdit in the
// reserved "__edits__" row keyed by the account code, which the sync layers back
// on top of the Power BI values every run (see flagCustomers in customer-sync.ts
// and FIX_EDIT_OVERRIDE_FIELDS). name/postcode additionally re-drive geocoding.
//
// Admin/developer only — this writes shared team data.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { makeRestaurant } from "@/lib/mock-data";
import { geocodePostcodes, canonicalPostcode } from "@/lib/geocode";
import { cleanCustomerName, type FixEdit } from "@/lib/customer-fix";
import type { Restaurant } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OVERRIDES = "ltp_overrides";
const ADDED = "ltp_added";
const UNMATCHED = "ltp_unmatched_customers";
const EDITS_ID = "__edits__";

async function session() {
  return verifySessionValue(cookies().get(SESSION_COOKIE)?.value);
}
function canEdit(role: string | undefined): boolean {
  return role === "admin" || role === "developer";
}

// The fields an admin can set/complete on a customer.
interface CustomerFields {
  name?: string;
  postcode?: string;
  address?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  sector?: string;
  accountCode?: string;
  accountManager?: string;
  businessType?: string;
  cuisineType?: string;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Merge a FixEdit into the reserved edits row (keyed by account code) so the
// hourly sync re-applies it. Partial merge keeps earlier saved fields.
async function saveEdit(key: string, patch: FixEdit): Promise<void> {
  if (!key) return;
  const sb = supabaseAdmin();
  const { data } = await sb.from(UNMATCHED).select("data").eq("id", EDITS_ID).maybeSingle();
  const edits = (data?.data as { edits?: Record<string, FixEdit> } | undefined)?.edits ?? {};
  const next: FixEdit = { ...edits[key] };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  edits[key] = next;
  await sb.from(UNMATCHED).upsert({ id: EDITS_ID, data: { edits } }, { onConflict: "id" });
}

async function geocode(postcode: string): Promise<{ latitude: number; longitude: number; district?: string } | null> {
  if (!postcode) return null;
  const g = (await geocodePostcodes([postcode])).get(canonicalPostcode(postcode));
  return g ? { latitude: g.latitude, longitude: g.longitude, district: g.district } : null;
}

// Which shared table a venue id lives in: manually-added / auto-placed customers
// are whole rows in ltp_added; FSA base venues are patched via ltp_overrides.
function isAddedId(id: string): boolean {
  return id.startsWith("pbi-") || id.startsWith("r-user-");
}

// Build the venue-field patch (Restaurant field names) from the edited fields.
function venuePatch(f: CustomerFields): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (clean(f.name)) p.name = cleanCustomerName(clean(f.name));
  if (f.address !== undefined) p.address = clean(f.address) || undefined;
  if (clean(f.contactName)) p.customerContactName = clean(f.contactName);
  if (clean(f.phone)) p.customerContactPhone = clean(f.phone);
  if (clean(f.email)) p.customerContactEmail = clean(f.email);
  if (clean(f.sector)) p.sector = clean(f.sector);
  if (clean(f.accountManager)) p.customerAccountManager = clean(f.accountManager);
  if (clean(f.businessType)) p.businessType = clean(f.businessType);
  if (clean(f.cuisineType)) p.cuisineType = clean(f.cuisineType);
  return p;
}

// The persisted FixEdit fields (a subset that survives the sync via __edits__).
function fixEditFrom(f: CustomerFields): FixEdit {
  const e: FixEdit = {};
  if (clean(f.name)) e.name = cleanCustomerName(clean(f.name));
  if (f.postcode !== undefined) e.postcode = clean(f.postcode);
  if (f.address !== undefined) e.address = clean(f.address);
  if (f.contactName !== undefined) e.contactName = clean(f.contactName);
  if (f.phone !== undefined) e.phone = clean(f.phone);
  if (f.email !== undefined) e.email = clean(f.email);
  if (f.sector !== undefined) e.sector = clean(f.sector);
  return e;
}

async function editCustomer(id: string, f: CustomerFields): Promise<void> {
  const sb = supabaseAdmin();
  const patch = venuePatch(f);

  // Relocate on a postcode change (geocode the corrected postcode).
  const newPostcode = clean(f.postcode);
  if (newPostcode) {
    patch.postcode = newPostcode;
    const g = await geocode(newPostcode);
    if (g) {
      patch.latitude = g.latitude;
      patch.longitude = g.longitude;
      if (g.district) patch.borough = g.district;
    }
  }

  if (isAddedId(id)) {
    // Whole-row record: merge into its data blob.
    const { data } = await sb.from(ADDED).select("data").eq("id", id).maybeSingle();
    const current = (data?.data as Record<string, unknown> | undefined) ?? null;
    if (!current) throw new Error("not-found");
    await sb.from(ADDED).upsert({ id, data: { ...current, ...patch } }, { onConflict: "id" });
  } else {
    // FSA base venue: merge into its override patch.
    const { data } = await sb.from(OVERRIDES).select("patch").eq("id", id).maybeSingle();
    const current = (data?.patch as Record<string, unknown> | undefined) ?? {};
    await sb.from(OVERRIDES).upsert({ id, patch: { ...current, existingCustomer: true, ...patch } }, { onConflict: "id" });
  }

  // Persist so the sync re-applies it (keyed by account code when known).
  const code = clean(f.accountCode);
  if (code) await saveEdit(code, fixEditFrom(f));
}

async function addCustomer(f: CustomerFields): Promise<string> {
  const name = cleanCustomerName(clean(f.name));
  const postcode = clean(f.postcode);
  if (!name) throw new Error("name-required");
  if (!postcode) throw new Error("postcode-required");
  const g = await geocode(postcode);
  if (!g) throw new Error("no-location");

  const code = clean(f.accountCode);
  const slug = (code || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const id = `pbi-${slug || Math.random().toString(36).slice(2, 9)}`;
  const borough = g.district || "London";

  const built: Restaurant = makeRestaurant({
    id,
    name,
    address: clean(f.address) || borough || postcode,
    postcode,
    borough,
    latitude: g.latitude,
    longitude: g.longitude,
    cuisineType: clean(f.cuisineType) || "Italian",
    businessType: clean(f.businessType) || "Customer account",
    priceTier: 3,
    email: clean(f.email) || undefined,
    phone: clean(f.phone) || undefined,
    existingCustomer: true,
  });
  built.excluded = false;
  built.source = "Power BI customer (added)";
  if (clean(f.contactName)) built.customerContactName = clean(f.contactName);
  if (clean(f.phone)) built.customerContactPhone = clean(f.phone);
  if (clean(f.email)) built.customerContactEmail = clean(f.email);
  if (clean(f.sector)) built.sector = clean(f.sector);
  if (clean(f.accountManager)) built.customerAccountManager = clean(f.accountManager);
  if (code) built.customerAccountCode = code;

  const { error } = await supabaseAdmin().from(ADDED).upsert({ id, data: built }, { onConflict: "id" });
  if (error) throw error;

  // If a Centric account code was given, remember the manual details so that once
  // the account starts syncing, flagCustomers keeps what the admin entered rather
  // than reverting to Centric blanks.
  if (code) await saveEdit(code, fixEditFrom(f));
  return id;
}

export async function POST(req: Request) {
  const s = await session();
  if (!s) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canEdit(s.role)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, error: "shared DB not configured" }, { status: 400 });

  let body: { action?: string; id?: string; fields?: CustomerFields };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const fields = body.fields ?? {};

  try {
    if (body.action === "add") {
      const id = await addCustomer(fields);
      return NextResponse.json({ ok: true, id });
    }
    if (body.action === "edit") {
      if (!body.id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
      await editCustomer(body.id, fields);
      return NextResponse.json({ ok: true, id: body.id });
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const status = msg === "no-location" || msg.endsWith("-required") ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
