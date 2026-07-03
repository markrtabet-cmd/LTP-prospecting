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

// ---- Auto-scheduler ---------------------------------------------------------

/** Planning horizon in calendar days (weekends are skipped inside it). */
export const SCHEDULE_HORIZON_DAYS = 14;

/** Most client visits the scheduler will pack into one day. Days can be much
 * lighter than this — a light day is prospecting time by design. */
export const MAX_VISITS_PER_DAY = 6;

/** A visit may be pulled this many days ahead of its due date… */
export const FLEX_DAYS_BEFORE = 2;
/** …or pushed this many days past it, when that groups nearby clients. */
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
