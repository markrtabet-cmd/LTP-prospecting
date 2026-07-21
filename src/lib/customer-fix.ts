// Shared shapes for the "Customers to fix" workflow — the list of Power BI
// customers the automatic sync could NOT confidently place on the map, surfaced
// for a human to link to an existing venue or add as a new one. Kept free of
// server-only imports so both the sync (server) and the fix page (client) can
// use it.

export type UnmatchedReason =
  | "no_postcode" // Power BI has no postcode — can't geocode or scope a match
  | "postcode_unresolved" // postcode present but postcodes.io couldn't place it
  | "ambiguous" // one or more candidate venues found — needs a human to pick
  | "no_match"; // geocoded fine, but no venue looks like it — likely brand new

export interface VenueSuggestion {
  venueId: string;
  name: string;
  postcode: string;
}

export interface UnmatchedCustomer {
  /** Stable id: the Power BI account code when present, else a name+postcode key. */
  id: string;
  name: string;
  postcode: string;
  /** Street address typed by an admin on the fix page (Power BI carries none). */
  address?: string;
  accountCode?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  accountManager?: string;
  /** Sector / trade channel from Power BI (see src/lib/sectors.ts). */
  sector?: string;
  /** Ordered within the last 3 months (undefined = no sales history to judge). */
  active?: boolean;
  /** Postcode centroid from postcodes.io, when it resolved. */
  latitude?: number;
  longitude?: number;
  /** Local-authority district (borough guess) from postcodes.io. */
  district?: string;
  /** True when only the outward code could be placed (approximate location). */
  approximate?: boolean;
  reason: UnmatchedReason;
  /** Existing venues that look like they could be this customer, best first. */
  suggestions: VenueSuggestion[];
  syncedAt: string;
}

// A correction saved via the fix page's "Edit details" or the profile's "Edit
// customer" panel. Stored in the reserved "__edits__" row of
// ltp_unmatched_customers as a map keyed by the customer's ORIGINAL natural key
// (account code, else the row id minus "fix_") so the hourly sync — which
// rebuilds customer fields wholesale from Power BI — can re-apply it every run.
// name/postcode are applied to the raw Power BI row before matching (so they
// re-drive geocoding + matching); the contact/sector fields are applied as
// MANUAL-WINS overrides on top of the Power BI values in flagCustomers, so an
// admin can complete a profile Centric left blank without the sync reverting it.
export interface FixEdit {
  name?: string;
  postcode?: string;
  address?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  sector?: string;
}

// The customer-panel fields a FixEdit can override on top of Power BI, mapped to
// their Restaurant field names. Shared by the sync and the manage API so both
// apply the same set. name/postcode/address are handled separately (raw-row +
// geocode), so they're not here.
export const FIX_EDIT_OVERRIDE_FIELDS: { edit: keyof FixEdit; venue: string }[] = [
  { edit: "contactName", venue: "customerContactName" },
  { edit: "phone", venue: "customerContactPhone" },
  { edit: "email", venue: "customerContactEmail" },
  { edit: "sector", venue: "sector" },
];

// Power BI customer names sometimes carry a leading status tag like
// "(INACTIVE) " that isn't part of the trading name — strip it for display.
// Everything else is kept verbatim so the app matches what reps see in Power BI.
export function cleanCustomerName(raw: string): string {
  const cleaned = raw.replace(/^\s*\((?:inactive|closed|dormant|do not use|old|ex)\)\s*/i, "").trim();
  return cleaned || raw.trim();
}

export const REASON_LABEL: Record<UnmatchedReason, string> = {
  no_postcode: "No postcode",
  postcode_unresolved: "Postcode not found",
  ambiguous: "Possible match — confirm",
  no_match: "Looks new — add it",
};

export const REASON_HINT: Record<UnmatchedReason, string> = {
  no_postcode: "Power BI has no postcode for this account, so it can't be placed on the map. Link it to the right venue, or add its postcode in Power BI.",
  postcode_unresolved: "The postcode in Power BI didn't resolve to a location. Link it to the right venue, or correct the postcode.",
  ambiguous: "We found venues that might be this customer. Confirm the right one to avoid a duplicate pin, or add it as new.",
  no_match: "No existing venue looks like this — most likely a genuinely new customer to add to the map.",
};
