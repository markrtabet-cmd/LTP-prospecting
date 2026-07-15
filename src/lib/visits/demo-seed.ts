// ============================================================================
// TEMPORARY demo calendar data — safe to delete.
//
// To remove ALL of it: set DEMO_CALENDAR_SEED to false (or delete this file,
// its three references in src/lib/meetings-store.tsx, and the
// applyDemoSalesOverlay call in src/lib/visits/useSuggestions.ts).
//
// These meetings are DISPLAY-ONLY. They are merged into the signed-in rep's
// in-memory meeting list so the calendar looks populated, but they are never
// written to Supabase: their ids start with DEMO_ID_PREFIX, which the store's
// mutation guards skip, so they can't leak to the shared ltp_meetings table or
// to other users. Nothing here touches production data.
//
// The pool is carved into DISJOINT groups so every part of the calendar has
// something to show:
//   0–2   booked-but-never-logged (status "missed") → the overdue panel
//   3–4   real visit rhythm, now overdue            → "Overdue" suggestions
//   5–6   real visit rhythm, due about now          → "Due soon" suggestions
//   7–9   sales-alert venues (fake salesHistory via applyDemoSalesOverlay)
//         → "Ordering down" / "Gone quiet" / "Product switch" suggestions
//   10–14 recently completed visits                 → grid history fill
//   15+   confirmed future bookings                 → grid future fill
// Suggestion venues (3–14) get NO future bookings — a booked venue is
// deliberately excluded from suggestions, so mixing the groups would empty
// the suggestions rail again.
//
// Overdue items are seeded already-"missed" (not "scheduled") on purpose: the
// suggestions engine only writes a status change back for *scheduled* visits
// that fall past their grace window, so pre-missed demo rows populate the
// overdue panel without ever triggering a write. Keep every PAST demo visit
// either "completed" or "missed" for the same reason.
// ============================================================================

import type { Meeting, Restaurant, SalesHistory } from "@/lib/types";
import { addDays, dateKeyToIso, toDateKey } from "./dates";

// Turned OFF now the app is going live with real individual accounts — the
// calendars start empty and fill with each rep's real meetings. Flip back to
// true only to repopulate a demo; see the header for the full removal path.
export const DEMO_CALENDAR_SEED = false;

export const DEMO_ID_PREFIX = "demo_";

export function isDemoMeetingId(id: string): boolean {
  return id.startsWith(DEMO_ID_PREFIX);
}

/** Deterministic venue pool: customers first (in store order) so both the
 * meeting seed and the sales overlay pick the SAME venues by index. */
function demoPool(venues: Restaurant[]): Restaurant[] {
  const customers = venues.filter((v) => v.existingCustomer);
  return customers.length >= 10 ? customers : venues;
}

interface DemoVisit {
  /** Pool index — keeps the groups disjoint. */
  venueIdx: number;
  /** Days from today; negative is in the past. */
  offset: number;
  type: Meeting["type"];
  status: "completed" | "missed" | "scheduled";
  reason?: string;
  notes?: string;
  followUp?: boolean;
}

const DEMO_VISITS: DemoVisit[] = [
  // ---- 0–2: booked, never logged → overdue "did these happen?" panel
  { venueIdx: 0, offset: -22, type: "visit", status: "missed", reason: "Monthly check-in — never logged." },
  { venueIdx: 1, offset: -19, type: "call", status: "missed", reason: "Promised call-back on the new range." },
  { venueIdx: 2, offset: -16, type: "visit", status: "missed", reason: "Was meant to pop in with samples." },

  // ---- 3–4: learned ~28–30d rhythm, last visit well past due → Overdue
  { venueIdx: 3, offset: -91, type: "visit", status: "completed", notes: "Quarterly range review." },
  { venueIdx: 3, offset: -63, type: "visit", status: "completed", notes: "Dropped fresh pasta samples." },
  { venueIdx: 3, offset: -35, type: "visit", status: "completed", notes: "Restock visit — happy with volumes." },
  { venueIdx: 4, offset: -105, type: "visit", status: "completed", notes: "First tasting with the head chef." },
  { venueIdx: 4, offset: -75, type: "call", status: "completed", notes: "Confirmed the standing order." },
  { venueIdx: 4, offset: -45, type: "visit", status: "completed", notes: "Menu refresh chat, left price list." },

  // ---- 5–6: same rhythm, due right about now → Due soon
  { venueIdx: 5, offset: -87, type: "visit", status: "completed", notes: "Kitchen walkthrough." },
  { venueIdx: 5, offset: -58, type: "visit", status: "completed", notes: "Tasting — keen on the burrata." },
  { venueIdx: 5, offset: -29, type: "visit", status: "completed", notes: "Regular visit, all good." },
  { venueIdx: 6, offset: -81, type: "call", status: "completed", notes: "Reorder call." },
  { venueIdx: 6, offset: -54, type: "visit", status: "completed", notes: "Delivered the new-season menu." },
  { venueIdx: 6, offset: -26, type: "visit", status: "completed", notes: "Quick drop-in, chef happy." },

  // ---- 7–9: recently seen, but Power BI sales flags (overlay below)
  { venueIdx: 7, offset: -10, type: "visit", status: "completed", notes: "Routine visit — didn't mention volumes." },
  { venueIdx: 8, offset: -12, type: "call", status: "completed", notes: "Left a voicemail about reordering." },
  { venueIdx: 9, offset: -9, type: "visit", status: "completed", notes: "Dropped samples of the truffle range." },

  // ---- 10–14: recent history so the grid's past weeks look lived-in
  { venueIdx: 10, offset: -13, type: "visit", status: "completed", notes: "Walked the kitchen, sorted cold storage." },
  { venueIdx: 11, offset: -6, type: "visit", status: "completed", followUp: true, notes: "Tasting went well; follow up on the ravioli quote." },
  { venueIdx: 12, offset: -4, type: "visit", status: "completed", notes: "Standing Friday drop-in." },
  { venueIdx: 13, offset: -2, type: "visit", status: "completed", notes: "Delivered squid-ink linguine samples." },
  { venueIdx: 14, offset: -1, type: "call", status: "completed", notes: "Quick check-in, reorder next week." },

  // ---- 15+: confirmed future bookings (never on suggestion venues)
  { venueIdx: 15, offset: 0, type: "visit", status: "scheduled", reason: "Standing drop-in." },
  { venueIdx: 16, offset: 0, type: "call", status: "scheduled", reason: "Chase the tortelloni quote." },
  { venueIdx: 17, offset: 1, type: "visit", status: "scheduled", reason: "New product tasting." },
  { venueIdx: 18, offset: 2, type: "visit", status: "scheduled", reason: "Quarterly review." },
  { venueIdx: 19, offset: 3, type: "call", status: "scheduled", reason: "Confirm festive volumes." },
  { venueIdx: 20, offset: 4, type: "visit", status: "scheduled", reason: "Sample drop." },
  { venueIdx: 21, offset: 6, type: "visit", status: "scheduled", reason: "Review cold storage." },
  { venueIdx: 22, offset: 7, type: "visit", status: "scheduled", reason: "Weekly visit." },
  { venueIdx: 23, offset: 8, type: "call", status: "scheduled", reason: "Review pricing." },
  { venueIdx: 24, offset: 9, type: "visit", status: "scheduled", reason: "Reconnect visit." },
  { venueIdx: 25, offset: 11, type: "visit", status: "scheduled", reason: "Menu refresh." },
  { venueIdx: 26, offset: 13, type: "visit", status: "scheduled", reason: "Fortnightly visit." },
  { venueIdx: 27, offset: 14, type: "call", status: "scheduled", reason: "Follow up on samples." },
  { venueIdx: 28, offset: 15, type: "visit", status: "scheduled", reason: "Tasting session." },
  { venueIdx: 29, offset: 17, type: "visit", status: "scheduled", reason: "Check stock levels." },
  { venueIdx: 30, offset: 20, type: "visit", status: "scheduled", reason: "Monthly review." },
  { venueIdx: 31, offset: 22, type: "call", status: "scheduled", reason: "Confirm order." },
  { venueIdx: 32, offset: 24, type: "visit", status: "scheduled", reason: "New-opening follow-up." },
];

/**
 * Build the demo meetings for a rep. Ids are deterministic (demo_0, demo_1, …)
 * so they stay stable across re-renders. Venues come from demoPool so clicking
 * through to a profile works and (for customers) shows live sales.
 */
export function buildDemoMeetings(repId: string, repName: string, venues: Restaurant[]): Meeting[] {
  if (!repId) return [];
  const pool = demoPool(venues);
  if (pool.length === 0) return [];

  const today = new Date();
  const createdAt = today.toISOString();

  return DEMO_VISITS.map((p, i) => {
    const venue = pool[p.venueIdx % pool.length];
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

// ---- Demo Power BI sales histories -----------------------------------------
// Overlaid onto pool venues 7–9 INSIDE the suggestions computation only (see
// useSuggestions), so the "Ordering down" / "Gone quiet" / "Product switch"
// reasons — and their filter chips — have something to show. Never persisted,
// never visible on any other screen.

/** yyyy-MM for the month `back` months before the current one. */
function monthKeyAgo(back: number): string {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - back, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
}

function demoHistories(): SalesHistory[] {
  const syncedAt = new Date().toISOString();
  // Pool venue 7 — volume drop: recent 3 full months down ~54% on the prior 3.
  const volumeDrop: SalesHistory = {
    monthly: [
      { month: monthKeyAgo(6), sales: 1400, kg: 118 },
      { month: monthKeyAgo(5), sales: 1250, kg: 104 },
      { month: monthKeyAgo(4), sales: 1350, kg: 112 },
      { month: monthKeyAgo(3), sales: 700, kg: 58 },
      { month: monthKeyAgo(2), sales: 600, kg: 50 },
      { month: monthKeyAgo(1), sales: 550, kg: 46 },
    ],
    priorProducts: [],
    recentProducts: [],
    syncedAt,
  };
  // Pool venue 8 — gone quiet: regular orders that stop 3 months ago.
  const stopped: SalesHistory = {
    monthly: [
      { month: monthKeyAgo(8), sales: 820, kg: 70 },
      { month: monthKeyAgo(7), sales: 760, kg: 64 },
      { month: monthKeyAgo(6), sales: 840, kg: 71 },
      { month: monthKeyAgo(5), sales: 790, kg: 66 },
      { month: monthKeyAgo(4), sales: 810, kg: 68 },
      { month: monthKeyAgo(3), sales: 780, kg: 65 },
    ],
    priorProducts: [],
    recentProducts: [],
    syncedAt,
  };
  // Pool venue 9 — product switch: steady spend, but the beef ravioli they
  // always bought collapses while a truffle line appears in its place.
  const productSwitch: SalesHistory = {
    monthly: [
      { month: monthKeyAgo(6), sales: 900, kg: 75 },
      { month: monthKeyAgo(5), sales: 920, kg: 77 },
      { month: monthKeyAgo(4), sales: 880, kg: 73 },
      { month: monthKeyAgo(3), sales: 910, kg: 76 },
      { month: monthKeyAgo(2), sales: 890, kg: 74 },
      { month: monthKeyAgo(1), sales: 930, kg: 78 },
    ],
    priorProducts: [
      { code: "RAV-BEEF", description: "Beef & Barolo Ravioli", sales: 420 },
      { code: "GNO-CLA", description: "Classic Potato Gnocchi", sales: 260 },
      { code: "BUR-125", description: "Burrata 125g", sales: 220 },
    ],
    recentProducts: [
      { code: "TAG-TRUF", description: "Truffle Tagliolini", sales: 400 },
      { code: "GNO-CLA", description: "Classic Potato Gnocchi", sales: 280 },
      { code: "BUR-125", description: "Burrata 125g", sales: 240 },
      { code: "RAV-BEEF", description: "Beef & Barolo Ravioli", sales: 30 },
    ],
    syncedAt,
  };
  return [volumeDrop, stopped, productSwitch];
}

/**
 * Return a copy of `venues` where pool venues 7–9 carry the demo sales
 * histories above. Applied only inside the suggestions computation; no-op when
 * the seed is off.
 */
export function applyDemoSalesOverlay(venues: Restaurant[]): Restaurant[] {
  if (!DEMO_CALENDAR_SEED) return venues;
  const pool = demoPool(venues);
  if (pool.length === 0) return venues;
  const histories = demoHistories();
  const overlayByVenueId = new Map<string, SalesHistory>();
  histories.forEach((h, i) => {
    const venue = pool[(7 + i) % pool.length];
    overlayByVenueId.set(venue.id, h);
  });
  return venues.map((v) => {
    const overlay = overlayByVenueId.get(v.id);
    return overlay ? { ...v, salesHistory: overlay } : v;
  });
}
