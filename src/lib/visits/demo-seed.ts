// ============================================================================
// TEMPORARY demo calendar data — safe to delete.
//
// To remove ALL of it: set DEMO_CALENDAR_SEED to false (or delete this file and
// its three references in src/lib/meetings-store.tsx).
//
// These meetings are DISPLAY-ONLY. They are merged into the signed-in rep's
// in-memory meeting list so the calendar looks populated, but they are never
// written to Supabase: their ids start with DEMO_ID_PREFIX, which the store's
// mutation guards skip, so they can't leak to the shared ltp_meetings table or
// to other users. Nothing here touches production data.
//
// Overdue items are seeded already-"missed" (not "scheduled") on purpose: the
// suggestions engine only writes a status change back for *scheduled* visits
// that fall past their grace window, so pre-missed demo rows populate the
// overdue panel without ever triggering a write. Keep every PAST demo visit
// either "completed" or "missed" for the same reason.
// ============================================================================

import type { Meeting, Restaurant } from "@/lib/types";
import { addDays, dateKeyToIso, toDateKey } from "./dates";

export const DEMO_CALENDAR_SEED = true;

export const DEMO_ID_PREFIX = "demo_";

export function isDemoMeetingId(id: string): boolean {
  return id.startsWith(DEMO_ID_PREFIX);
}

type DemoStatus = "completed" | "missed" | "scheduled";

interface DemoPlanEntry {
  /** Days from today; negative is in the past. */
  offset: number;
  type: Meeting["type"];
  status: DemoStatus;
  reason?: string;
  notes?: string;
  followUp?: boolean;
}

// A ~5-week spread with several visits most days. Past = completed, a handful
// left un-logged (missed) to fill the overdue panel, today + future scheduled.
const DEMO_PLAN: DemoPlanEntry[] = [
  // ---- Overdue: booked, never logged (populate the "did these happen?" panel)
  { offset: -22, type: "in_person", status: "missed", reason: "Monthly check-in — never logged." },
  { offset: -19, type: "phone", status: "missed", reason: "Promised call-back on the new range." },
  { offset: -16, type: "in_person", status: "missed", reason: "Sales slipping — was meant to pop in." },

  // ---- Completed history (fills past days on the grid)
  { offset: -20, type: "in_person", status: "completed", notes: "Dropped fresh pasta samples — chef keen on the beef shin ragu." },
  { offset: -18, type: "phone", status: "completed", notes: "Reordered gnocchi, happy with delivery times." },
  { offset: -15, type: "in_person", status: "completed", followUp: true, notes: "Menu tasting; wants a quote for the tortelloni range." },
  { offset: -13, type: "site_visit", status: "completed", notes: "Walked the kitchen, sorted storage for the frozen lines." },
  { offset: -12, type: "in_person", status: "completed", notes: "Quarterly review — upsold the burrata." },
  { offset: -10, type: "phone", status: "completed", notes: "Confirmed the weekly standing order." },
  { offset: -9, type: "in_person", status: "completed", notes: "Left the new-season menu with the GM." },
  { offset: -6, type: "in_person", status: "completed", followUp: true, notes: "Tasting went well; follow up on the ravioli quote." },
  { offset: -5, type: "phone", status: "completed", notes: "Sorted a credit on the last invoice." },
  { offset: -4, type: "in_person", status: "completed", notes: "Standing Friday drop-in, all good." },
  { offset: -2, type: "in_person", status: "completed", notes: "Delivered samples of the squid-ink linguine." },
  { offset: -1, type: "phone", status: "completed", notes: "Quick check-in, reorder next week." },

  // ---- Today
  { offset: 0, type: "in_person", status: "scheduled", reason: "Standing Tuesday drop-in." },
  { offset: 0, type: "phone", status: "scheduled", reason: "Chase the tortelloni quote." },

  // ---- Upcoming (fills the rest of the month and into the next)
  { offset: 1, type: "in_person", status: "scheduled", reason: "New product tasting." },
  { offset: 2, type: "in_person", status: "scheduled", reason: "Ordering down — reconnect." },
  { offset: 3, type: "phone", status: "scheduled", reason: "Confirm festive volumes." },
  { offset: 4, type: "in_person", status: "scheduled", reason: "Sample drop." },
  { offset: 6, type: "site_visit", status: "scheduled", reason: "Review cold storage." },
  { offset: 7, type: "in_person", status: "scheduled", reason: "Weekly visit." },
  { offset: 8, type: "phone", status: "scheduled", reason: "Review pricing." },
  { offset: 9, type: "in_person", status: "scheduled", reason: "Gone quiet — pop in." },
  { offset: 11, type: "in_person", status: "scheduled", reason: "Menu refresh." },
  { offset: 13, type: "in_person", status: "scheduled", reason: "Fortnightly visit." },
  { offset: 14, type: "phone", status: "scheduled", reason: "Follow up on samples." },
  { offset: 15, type: "in_person", status: "scheduled", reason: "Tasting session." },
  { offset: 17, type: "in_person", status: "scheduled", reason: "Check stock levels." },
  { offset: 20, type: "in_person", status: "scheduled", reason: "Monthly review." },
  { offset: 22, type: "phone", status: "scheduled", reason: "Confirm order." },
  { offset: 24, type: "in_person", status: "scheduled", reason: "New-opening follow-up." },
];

/**
 * Build the demo meetings for a rep. Ids are deterministic (demo_0, demo_1, …)
 * so they stay stable across re-renders — important, or React keys churn and
 * the overdue sweep would re-fire. Venues are drawn from the rep's real list so
 * clicking through to a profile works; customers are preferred so the profile
 * shows live sales.
 */
export function buildDemoMeetings(repId: string, repName: string, venues: Restaurant[]): Meeting[] {
  if (!repId || venues.length === 0) return [];
  const customers = venues.filter((v) => v.existingCustomer);
  const pool = customers.length >= 6 ? customers : venues;
  if (pool.length === 0) return [];

  const today = new Date();
  const createdAt = today.toISOString();

  return DEMO_PLAN.map((p, i) => {
    const venue = pool[i % pool.length];
    return {
      id: `${DEMO_ID_PREFIX}${i}`,
      repId,
      repName,
      venueId: venue.id,
      venueName: venue.name,
      date: dateKeyToIso(toDateKey(addDays(today, p.offset))),
      type: p.type,
      status: p.status,
      locked: true,
      source: "rep",
      reason: p.reason,
      notes: p.notes,
      followUpRequired: p.followUp,
      createdAt,
    } satisfies Meeting;
  });
}
