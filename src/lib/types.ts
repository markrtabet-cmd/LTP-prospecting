// Core domain types for the LTP prospecting tool.
// These mirror the data model in the PRD (section 14) and are the single
// source of truth the UI renders against. When the Supabase backend is added,
// the API layer should return these same shapes.

import type {
  IntervalMode,
  MeetingSource,
  MeetingStatus,
  MeetingType,
} from "./visits/types";

export type LeadCategory = "high" | "good" | "possible" | "low";

export type OutreachStatus =
  | "not_contacted"
  | "draft_ready"
  | "scheduled"
  | "sent"
  | "replied"
  | "bounced"
  | "converted"
  | "unsubscribed";

export type OpeningStatus = "open" | "opening_soon" | "new_this_week" | "closed";

// What happened on a contact/sales attempt. Drives the badge on each log entry.
export type ContactOutcome =
  | "called"
  | "emailed"
  | "visited"
  | "meeting"
  | "samples_sent"
  | "quote_sent"
  | "interested"
  | "not_interested"
  | "no_answer"
  | "follow_up"
  | "other";

// One entry in a venue's contact log: who tried to sell to this restaurant,
// when, and what happened. Persisted per-venue via the store (overrides / added).
export interface ContactNote {
  id: string;
  author: string; // who logged it (typed in — there are no per-user logins)
  text: string;
  outcome?: ContactOutcome;
  at: string; // ISO timestamp
}

// Pin / row colour buckets (PRD map + table colour coding).
export type PinStatus =
  | "high"
  | "medium"
  | "low"
  | "existing_customer"
  | "new_opening"
  | "excluded"
  | "closed";

// Compatibility is scored on TWO factors only: cuisine and price.
export type PriceTier = 1 | 2 | 3 | 4; // £ / ££ / £££ / ££££

export interface ScoreBreakdown {
  cuisineFit: number; // 0-50
  priceFit: number; // 0-50
}

export interface Restaurant {
  id: string;
  name: string;
  address: string;
  postcode: string;
  borough: string;
  latitude: number;
  longitude: number;
  website?: string;
  phone?: string;
  email?: string;
  cuisineType: string;
  businessType: string;
  priceTier: PriceTier;
  hygieneRating?: number; // 0-5
  openingStatus: OpeningStatus;
  firstSeenDate: string;
  lastSeenDate: string;
  source: string;
  existingCustomer: boolean;
  excluded: boolean;
  insideDeliveryArea: boolean;
  leadScore: number; // 0-100
  leadCategory: LeadCategory;
  recommended: boolean; // compatible cuisine AND semi-high-class price
  scoreBreakdown: ScoreBreakdown;
  scoreReason: string;
  assignedOwner?: string;
  outreachStatus: OutreachStatus;
  menuSummary?: string;
  pastaRelevance?: string;
  notes?: string;
  // Timestamped log of contact/sales attempts (calls, emails, visits, outcomes).
  contactLog?: ContactNote[];
  // Customer account fields synced nightly from Power BI (only set once a
  // venue is matched as an existing customer — see src/lib/customer-sync.ts).
  customerContactName?: string;
  customerContactPhone?: string;
  customerContactEmail?: string;
  customerAccountManager?: string;
  // Power BI CustomerAccountCode — the key the mobile Contact/Sales panels use
  // to run live per-customer DAX queries.
  customerAccountCode?: string;
  nextAction?: string;
  openingEvidence?: string;
  // Article/source URL the web scan found this opening in — kept separate
  // from `website` (the restaurant's own site) so New Openings can link out
  // to the source without ever showing an article link as the venue's site.
  openingSourceUrl?: string;
  expectedOpeningDate?: string;
  // Set true when someone clicks "Remove as new" — the venue is kept but drops
  // out of the New openings view, and a later web scan won't re-flag it as new.
  dismissedAsNew?: boolean;
  // Saved/AI-written outreach email (overrides the default template).
  emailSubject?: string;
  emailBody?: string;
  emailTo?: string;
  // Visit cadence for the meeting calendar (set by the rep on the profile /
  // record flow). See VisitSettings below.
  visitSettings?: VisitSettings;
  // Manual owner override for the calendar: which rep's calendar this venue
  // belongs to. When unset, the rep is derived by matching
  // customerAccountManager against each rep's aliases (see repForVenue).
  assignedRepId?: string;
  // Sales-health snapshot synced nightly from Power BI (see
  // src/lib/customer-sync.ts) — feeds the calendar's "worth a catch-up visit"
  // alerts (src/lib/visits/sales-health.ts). Only set for matched customers.
  salesHistory?: SalesHistory;
}

export interface EmailDraft {
  id: string;
  restaurantId: string;
  restaurantName: string;
  to: string;
  subject: string;
  body: string;
  status: "ready" | "scheduled" | "sent" | "replied" | "bounced";
  scheduledFor?: string;
  salesperson?: string;
}

// ---- Visit calendar (per-rep meeting scheduling) ----------------------------

// Per-venue visit cadence, set by the rep ("how often do I need to see them").
// Rides the Restaurant JSONB like contactLog does. The learned rhythm engine
// (src/lib/visits) runs alongside as a reality check.
export interface VisitSettings {
  intervalMode: IntervalMode;
  /** Fixed interval in days when intervalMode is "manual". */
  manualIntervalDays?: number | null;
  /** Fixed next-visit date (local-noon ISO) when intervalMode is "custom_date". */
  customNextDate?: string | null;
  /** The rep's "I normally visit them every N days" answer — blended with the
   * learned rhythm while history is thin. */
  expectedIntervalDays?: number | null;
  setupCompleted?: boolean;
  /** A pushed-back or skipped suggestion reappears on this date (local-noon
   * ISO). Dates in the past have no effect — self-expiring, nothing to clean. */
  snoozedUntil?: string | null;
  /** Optional "why" the rep gave when snoozing. */
  snoozeReason?: string | null;
}

// ---- Sales-health (Power BI decline scanning) -------------------------------

/** One calendar month of a venue's sales, synced from Power BI. */
export interface SalesMonthPoint {
  /** yyyy-MM. */
  month: string;
  sales: number;
  kg: number | null;
}

/** A venue's total spend on one product over a sync window. */
export interface SalesProductPoint {
  code: string;
  description: string;
  sales: number;
}

// Rides the Restaurant JSONB like visitSettings does. Nothing derived is
// stored here — src/lib/visits/sales-health.ts recomputes alerts from these
// raw figures on the fly, so threshold tweaks never need a resync.
export interface SalesHistory {
  /** Oldest → newest, last several calendar months. */
  monthly: SalesMonthPoint[];
  /** Per-product totals for the PRIOR comparison window. */
  priorProducts: SalesProductPoint[];
  /** Per-product totals for the RECENT comparison window. */
  recentProducts: SalesProductPoint[];
  /** ISO timestamp of the sync that produced this snapshot. */
  syncedAt: string;
}

// One meeting (past, scheduled, missed or cancelled) between a rep and a venue.
// Stored in the ltp_meetings table (id, data jsonb) — NOT inside the Restaurant
// blob, because the calendar queries them per rep independently of venue data.
// Audio and full transcripts live in Supabase Storage; only their object paths
// are stored here so payloads stay small.
export interface Meeting {
  id: string;
  repId: string;
  repName?: string;
  venueId: string;
  venueName: string;
  /** Local-noon ISO — same day-precision convention as ContactNote.at. */
  date: string;
  type: MeetingType;
  status: MeetingStatus;
  /** Every confirmed meeting is locked — a firm booking, never something a
   * background process moves on its own. */
  locked: boolean;
  source: MeetingSource;
  /** What the follow-up commitment was, when source is "followup". */
  reason?: string;
  notes?: string;
  aiSummary?: string;
  actionItems?: string[];
  followUpRequired?: boolean;
  /** Supabase Storage object path (meeting-media bucket) — never a URL. */
  audioPath?: string;
  audioMimeType?: string;
  /** Storage path of the full transcript; the text itself is never stored here. */
  transcriptPath?: string;
  createdAt: string;
  updatedAt?: string;
}

// A salesperson. Stored in ltp_users (id, data jsonb). Passwords are PBKDF2
// hashes; a rep without one signs in with the shared SITE_PASSWORD.
export interface Rep {
  id: string; // slug of the name, e.g. "mark-tabet"
  name: string;
  /** Power BI account-manager spellings that map customers to this rep. */
  aliases?: string[];
  passwordHash?: string;
  passwordSalt?: string;
  createdAt?: string;
}
