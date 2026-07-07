// Tuning constants for the visit rhythm / reminder / scheduler engines.
// Plain constants (not env vars): the engines run client-side where server env
// isn't visible, and these defaults suit LTP's field-sales cadence.

/** Fallback visit interval when a client has no history and no set frequency. */
export const DEFAULT_INTERVAL_DAYS = 30;

/** How many days before the due date a client counts as "due soon". */
export const DUE_SOON_LEAD_DAYS = 7;

/** How many recent gaps the learned-rhythm engine looks at. */
export const INTERVAL_WINDOW = 5;

/** £ value of a "top" client — anchors the log-scaled priority value axis. */
export const PRIORITY_VALUE_REFERENCE = 100_000;

// ---- Suggestion placement ---------------------------------------------------
// (weekends are skipped across all of these)

/** Most visits a suggested day will be allowed to batch onto. Days can be much
 * lighter than this — a light day is prospecting time by design. */
export const MAX_VISITS_PER_DAY = 6;

/** A suggested date may be pulled this many days ahead of the due date… */
export const FLEX_DAYS_BEFORE = 2;
/** …or pushed this many days past it, when that groups nearby venues. */
export const FLEX_DAYS_AFTER = 4;

/** A logged meeting completes a scheduled one for the same venue when their
 * dates are within this many days of each other. */
export const RECONCILE_GRACE_DAYS = 3;

/** Rough cost (in metres of detour) of opening a brand-new day cluster —
 * discourages scattering one-visit days when grouping is possible. */
export const NEW_DAY_COST_METERS = 4_000;

/** Cost (in metres) per day of lateness past the due date, so far-away grouping
 * never wins over weeks of delay. */
export const LATENESS_COST_METERS_PER_DAY = 2_500;

/** "Nearby that day" means a CONFIRMED booking that day within this range —
 * i.e. the detour is cheaper than opening a fresh day (kept in the same spirit
 * as NEW_DAY_COST_METERS). Suggestions merely co-placed on the same day, or
 * miles from the booked stop, don't get the nearby flag. */
export const NEARBY_RADIUS_METERS = 4_000;

// ---- Suggested visits (calendar tab) ----------------------------------------

/** How far ahead the Suggestions rail looks for rhythm-due venues. */
export const SUGGESTION_HORIZON_DAYS = 21;

/** A suggestion may drift this fraction of its interval either side of the due
 * date (the rep's "couldn't make that exact day" allowance) before it counts
 * as fully missed rather than merely late. */
export const SUGGESTION_WINDOW_PCT = 0.25;

/** A CONFIRMED visit whose date + its ±window has passed without being logged
 * escalates into the daily overdue/"needs logging" panel. */
export const NEEDS_LOGGING_GRACE_DAYS_MIN = 1;

// ---- Sales-health (Power BI decline scanning) -------------------------------

/** Fractional fall in recent vs prior monthly sales that counts as a drop. */
export const SALES_DROP_THRESHOLD = 0.3;
/** Consecutive recent zero-order months that count as "stopped ordering". */
export const SALES_STOPPED_MONTHS = 2;
/** Months either side used to compare "recent" vs "before" for the volume /
 * stopped-ordering checks. */
export const SALES_WINDOW_MONTHS = 3;

/** A product needs at least this share of a window's sales to count as a
 * meaningful part of what the venue buys. */
export const PRODUCT_SIGNIFICANT_SHARE = 0.15;
/** ...and at least this much absolute spend, so a tiny/new account never fires
 * on noise. */
export const PRODUCT_MIN_SIGNIFICANT_SALES = 30;
/** A once-significant product counts as "dropped" once it falls below this
 * fraction of its former share. */
export const PRODUCT_DROP_RATIO = 0.2;
/** Rolling window (days) used for both sides of the product-switch
 * comparison — kept in sync with the Power BI sync's product query. */
export const PRODUCT_WINDOW_DAYS = 90;
