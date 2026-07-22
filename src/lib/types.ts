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
  /** Which rep logged this. Notes are stored on the shared venue blob, but a rep
   * only SEES their own activity (admins/devs see everyone's) — see
   * src/lib/activity-visibility.ts. Absent on pre-login notes (matched by author
   * name instead). */
  repId?: string;
  /** Set when this note mirrors a recorded meeting — links to the Meeting in
   * the meetings store so the activity detail can show its audio/transcript/
   * AI summary. See RecordMeetingSheet. */
  meetingId?: string;
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
  // Customer sector / trade channel from Power BI (F_DAILY[Market]), e.g.
  // "Hotels", "Delis", "Italian restaurant". Drives the "relevant sectors only"
  // filter — see src/lib/sectors.ts. Only set on existing customers.
  sector?: string;
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
  // Prospect ownership ("mark as yours"): when a rep takes charge of a lead it
  // drops off every OTHER rep's leads so nobody chases the same venue. Admins
  // and developers still see it, with the owner's name. Distinct from
  // `excluded` (which hides a venue from EVERYONE, including admins). Set on the
  // shared venue blob, so a claim is visible team-wide. See src/lib/ownership.ts.
  claimedByRepId?: string;
  claimedByRepName?: string;
  claimedAt?: string; // ISO timestamp
  // Sales-health snapshot synced nightly from Power BI (see
  // src/lib/customer-sync.ts) — feeds the calendar's "worth a catch-up visit"
  // alerts (src/lib/visits/sales-health.ts). Only set for matched customers.
  salesHistory?: SalesHistory;
  // DEPRECATED. Activity is now purely sales-recency driven (inactive after N
  // months with no order, active again the moment they order — see
  // src/lib/customer-activity.ts). The old manual Active/Inactive override is no
  // longer read or written; the field is kept only so any legacy value already
  // in the shared blob deserialises without error.
  customerActive?: boolean | null;
  // Why this customer has gone inactive, synced from Power BI (only when
  // POWERBI_INACTIVITY_REASON_COLUMN is configured — see src/lib/customer-sync.ts).
  // Shown as the "Reason" column on the Customers list; while it's absent the
  // calendar prompts the rep to schedule a meeting to find out. See
  // inactivityReason() in src/lib/customer-activity.ts, which also falls back to
  // the CLOSED/INACTIVE/DUPLICATE status Power BI carries in the rep field. null
  // when a sync clears a previously-synced reason (Power BI blanked it).
  inactivityReason?: string | null;
  // The customer's account lifecycle status from Power BI (F_DAILY[Account
  // Status]): "Active" / "Closed" / "On Stop". Synced per customer when
  // POWERBI_ACCOUNT_STATUS_COLUMN is configured (default "Account Status").
  // This is the AUTHORITATIVE inactive flag: a status other than the active
  // value means inactive, overriding the sales-recency rule — see
  // customerActivity() in src/lib/customer-activity.ts. null when Power BI has
  // no status on record (activity then falls back to sales recency).
  accountStatus?: string | null;
  // The owner/operator group this customer belongs to, from Power BI
  // (F_DAILY[Customer Group]) — e.g. "SOHO HOUSE", "URBAN PUBS". Multiple venues
  // sharing a non-blank, non-"INDEPENDENT" value are one group run by the same
  // people. Synced when POWERBI_OWNER_GROUP_COLUMN is configured (default
  // "Customer Group"). null / undefined for independents. Drives the group +
  // head-office logic in src/lib/groups.ts. Distinct from the name-based chain
  // grouping in src/lib/chains.ts.
  ownerGroup?: string | null;
  // Group-level visit plan, chosen by a rep on any member's profile and
  // replicated across every member of the same ownerGroup (via updateMany).
  // Lets a group be visited head-office-only instead of member-by-member — the
  // calendar then suggests only the head office. See src/lib/groups.ts.
  groupVisit?: GroupVisitSettings;
  // A rep-set "go visit them on this day" flag from the leads table pin, stored
  // as a yyyy-MM-dd date key (null clears it — an explicit value so it survives
  // the patch-merge to the shared blob). Surfaced on the calendar day view as a
  // "flagged to visit" list beneath that day's booked visits.
  flaggedVisitDate?: string | null;
  /** AI verdict on how the pursuit of this prospect is going, judged from the
   * latest rep note (see /api/meetings/summarize `sentiment`). Rides the shared
   * blob like contactLog. `noteId` is the invalidation key: when it no longer
   * matches the newest contactLog entry the verdict is stale and the leads badge
   * falls back to purple. */
  noteSentiment?: {
    verdict: "good" | "not_good";
    noteId: string;
    reason?: string;
    at: string; // ISO, when computed
  } | null;
  // Google Places id, spread in from the FSA dataset once a venue has been
  // enriched (see hydrateVenue). Its presence is what tells a real, enriched
  // `website` apart from a web-scan venue that only ever leaked an article URL.
  googlePlaceId?: string;
}

// Resolve a venue's *own* website for display, filtering out the scanned-opening
// source-article URL. The web-scan path never captured a real website: newer
// scans keep the article link in `openingSourceUrl`, while older scans (before
// that field existed) leaked it straight into `website`. Either way it must
// never surface as "the website". A web-scan venue's `website` is trustworthy
// only once Google Places enrichment has set it (googlePlaceId present).
export function venueWebsite(
  r: Pick<Restaurant, "website" | "openingSourceUrl" | "source" | "googlePlaceId">
): string | undefined {
  const w = r.website?.trim();
  if (!w) return undefined;
  if (r.openingSourceUrl && w === r.openingSourceUrl) return undefined;
  if (r.source === "Web scan" && !r.googlePlaceId) return undefined;
  return w;
}

// A venue is a genuine "new opening" only when a scan captured a source article
// for it. A new_this_week/opening_soon status with no openingSourceUrl is almost
// always an FSA data-pull gap (a venue the pipeline briefly dropped then re-added,
// resetting firstSeenDate) rather than a real opening — so it is NOT flagged.
export function isNewOpening(
  r: Pick<Restaurant, "openingStatus" | "openingSourceUrl">,
): boolean {
  return (
    (r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") &&
    !!r.openingSourceUrl
  );
}

/** True for a venue that lives as its OWN row in ltp_added (manually added by an
 * admin, added from the fix-customers flow, a web-scan opening, or auto-placed
 * by the Power BI sync) rather than a base FSA venue. Such rows are DELETED when
 * removed; base FSA venues are only un-flagged. Kept in one place so the
 * customers list, the profile page and /api/customers/manage all agree. */
export function isAddedVenueId(id: string): boolean {
  return id.startsWith("r-user-") || id.startsWith("pbi-") || id.startsWith("open-");
}

export interface EmailDraft {
  id: string;
  restaurantId: string;
  restaurantName: string;
  to: string;
  subject: string;
  body: string;
  status: "ready" | "scheduled" | "sent" | "replied" | "bounced";
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

// ---- Owner groups (head-office visit routing) -------------------------------

// How a customer group (venues sharing an ownerGroup) should be visited. Stored
// identically on every member of the group; a change on one member is written
// to all of them so the whole group agrees. See src/lib/groups.ts.
export interface GroupVisitSettings {
  /** "each" = visit every member on its own rhythm (default). "head_office" =
   * only the head office is scheduled/suggested; the other members drop out of
   * the calendar's rhythm suggestions. */
  mode: "each" | "head_office";
  /** Which member venue is the head office, when mode is "head_office". */
  headOfficeId?: string | null;
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
  /** Distinct order dates (yyyy-MM-dd) over the last ~6 months, newest last —
   * feeds the order-cadence "broken pattern" check (src/lib/visits/cadence.ts).
   * Absent on histories synced before cadence tracking was added. */
  orderDates?: string[];
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
  /** Optional time-of-day, "HH:mm" (24h). Absent = day-only (the historical
   * model); its presence upgrades the day view to a timed slot. */
  startTime?: string;
  /** Planned length in minutes (default 45) — feeds the time-slot suggestion. */
  durationMinutes?: number;
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
  /** Company email — binds this account to the Cloudflare Access identity, so
   * arriving as stefano.nicoli@… lands on Stefano's account automatically. */
  email?: string;
  /** Planned account tiers: 3 reps + admin + developer. Informational for now;
   * nothing is permission-gated on it yet. */
  role?: "rep" | "admin" | "developer";
  /** Email sign-off auto-appended when a draft opens in the rep's mail client.
   * Absent → a default "Best,\n<first name>\nLa Tua Pasta" is used. */
  signature?: string;
  passwordHash?: string;
  passwordSalt?: string;
  createdAt?: string;
}
