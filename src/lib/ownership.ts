// Prospect ownership + "active prospect" rules — the single source of truth for
// the Leads page and the dashboard's prospect KPI.
//
// Two independent mechanisms, deliberately kept apart:
//   • CLAIM ("mark as yours") — a rep takes charge of a lead. It drops off every
//     OTHER rep's leads (so nobody double-chases) but stays visible to admins
//     and developers, tagged with the owner. Auto-applied when a rep logs a
//     meeting with a prospect. Stored as claimedByRepId on the shared blob.
//   • EXCLUDE (Restaurant.excluded) — hides a venue from EVERYONE, admins
//     included. Handled globally in the store; nothing here touches it.

import { repForVenue } from "./visits/schedule";
import type { OutreachStatus, Rep, Restaurant } from "./types";

/** A lead is "in active outreach" once the first real touch has happened. */
export const IN_OUTREACH_STATUSES: OutreachStatus[] = ["sent", "replied", "scheduled"];

export function inOutreach(r: Restaurant): boolean {
  return IN_OUTREACH_STATUSES.includes(r.outreachStatus);
}

/** A prospect is any non-customer venue (excluded ones are already hidden by
 * the store, so they never reach these helpers). */
export function isProspect(r: Restaurant): boolean {
  return !r.existingCustomer;
}

/** Whether a rep may see this lead: unclaimed leads are the open pool everyone
 * works from; a claimed lead is visible only to the rep who owns it. */
export function leadVisibleToRep(r: Restaurant, repId: string): boolean {
  return !r.claimedByRepId || r.claimedByRepId === repId;
}

/** The dashboard KPI + the "my active prospects" toggle. Per the chosen
 * definition: a prospect claimed by me, OR one already in active outreach. */
export function isActiveProspectForRep(r: Restaurant, repId: string): boolean {
  if (r.existingCustomer) return false;
  if (r.claimedByRepId && r.claimedByRepId !== repId) return false; // owned by someone else
  return r.claimedByRepId === repId || inOutreach(r);
}

/** Company-wide active-prospect count (admin/developer dashboard): claimed by
 * anyone, or in active outreach. */
export function isActiveProspectForAnyone(r: Restaurant): boolean {
  if (r.existingCustomer) return false;
  return Boolean(r.claimedByRepId) || inOutreach(r);
}

/** Patch that claims a lead for a rep. */
export function claimPatch(rep: { id: string; name: string }): Partial<Restaurant> {
  return {
    claimedByRepId: rep.id,
    claimedByRepName: rep.name,
    claimedAt: new Date().toISOString(),
  };
}

/** Patch that releases a claim. Uses empty strings (not undefined) so the clear
 * survives JSON serialization to the shared store. */
export function unclaimPatch(): Partial<Restaurant> {
  return { claimedByRepId: "", claimedByRepName: "", claimedAt: "" };
}

/** Display name of whoever owns a claimed lead, or null if it's unclaimed. */
export function claimOwnerName(r: Restaurant): string | null {
  return r.claimedByRepId ? r.claimedByRepName || "a rep" : null;
}

/** Does this existing customer belong to the given rep? (manual assignment or
 * Power BI account-manager match). Used to colour the map's own vs other pins. */
export function ownsCustomer(r: Restaurant, rep: Rep, reps: Rep[]): boolean {
  if (!r.existingCustomer) return false;
  if (r.assignedRepId) return r.assignedRepId === rep.id;
  return repForVenue(r, reps)?.id === rep.id;
}
