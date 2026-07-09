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
  accountCode?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  accountManager?: string;
  /** Sector / trade channel from Power BI (see src/lib/sectors.ts). */
  sector?: string;
  /** Postcode centroid from postcodes.io, when it resolved. */
  latitude?: number;
  longitude?: number;
  /** Local-authority district (borough guess) from postcodes.io. */
  district?: string;
  reason: UnmatchedReason;
  /** Existing venues that look like they could be this customer, best first. */
  suggestions: VenueSuggestion[];
  syncedAt: string;
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
