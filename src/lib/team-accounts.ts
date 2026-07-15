// The fixed La Tua Pasta team roster — the single source of truth for WHO can
// sign in and WHAT they can see. Used in three places:
//   1. scripts/seed-team.mjs upserts these into the ltp_users table.
//   2. login-identity.ts falls back to this when the roster read fails or the
//      table is empty, so roles/emails work even before the seed has run.
//   3. Role helpers below drive every per-page scoping decision.
//
// Roles:
//   rep       — sees only their own customers, calendar, activity, leads and
//               AI insights.
//   admin     — sees everything (company-wide totals + every rep's data); has
//               no personal calendar, but can switch between the reps'.
//   developer — verifies their own email at Cloudflare, then chooses which
//               account to enter: any rep/admin (full access AS that person,
//               editing real data) or the isolated "Developer" sandbox.
//
// Power BI stores the account manager as an UPPERCASE FIRST NAME (STEFANO,
// TURI, LUCA, JESSICA, NICOLAS…), so each account's `aliases` include the first
// name — that's what maps synced customers to the right person (see repForVenue).

import { repSlug } from "./session";

export type Role = "rep" | "admin" | "developer";

export interface TeamAccount {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Power BI account-manager spellings that map customers to this person. */
  aliases: string[];
  /** Env var that holds this person's login password, when they've set one.
   * Lets each rep pick their own password later (in .env.local / Vercel)
   * without a DB re-seed. Both developers share LTP_PASSWORD_DEVELOPER. See
   * passwordFromEnv() (server-only). */
  passwordEnv: string;
}

function account(name: string, email: string, role: Role, aliases: string[], passwordEnv: string): TeamAccount {
  return { id: repSlug(name), name, email: email.toLowerCase(), role, aliases, passwordEnv };
}

export const TEAM_ACCOUNTS: TeamAccount[] = [
  // ---- Sales reps ----
  account("Stefano Nicoli", "stefano.nicoli@latuapasta.com", "rep", ["Stefano"], "LTP_PASSWORD_STEFANO"),
  account("Turi Palumbo", "turi.palumbo@latuapasta.com", "rep", ["Turi"], "LTP_PASSWORD_TURI"),
  account("Luca Beschin", "luca.beschin@latuapasta.com", "rep", ["Luca"], "LTP_PASSWORD_LUCA"),
  // ---- Admins ----
  // See company-wide data and can switch the whole site to view any single rep's
  // world (calendar, KPIs, customers, leads) via the top-right switcher. Given NO
  // aliases so they have no personal Power BI book — any accounts under their
  // name fold into the company total. Keep their own passwords where set.
  account("Jessica Scudetti", "jessica.scudetti@latuapasta.com", "admin", [], "LTP_PASSWORD_JESSICA"),
  account("Nicolas Hanson", "nicolas.hanson@latuapasta.com", "admin", [], "LTP_PASSWORD_NICOLAS"),
  account("Nick Bircham", "nick@bbanalytics.co.uk", "admin", [], "LTP_PASSWORD_NICK"),
  // ---- Developers ----
  account("Mark Tabet", "markrtabet@gmail.com", "developer", [], "LTP_PASSWORD_DEVELOPER"),
  account("Theodore Hanson", "theodore.hanson44@gmail.com", "developer", [], "LTP_PASSWORD_DEVELOPER"),
];

/** Server-only: the password this account has set via its env var, or undefined
 * if none is configured (fall back to the seeded roster hash / shared password).
 * Empty string counts as "not set" so a blank env line is a no-op. */
export function passwordFromEnv(account: Pick<TeamAccount, "passwordEnv"> | undefined | null): string | undefined {
  if (!account?.passwordEnv) return undefined;
  const v = process.env[account.passwordEnv];
  return v && v.trim() ? v : undefined;
}

/** The isolated developer test identity. Not a real person: matches no
 * customers, has an empty calendar/activity, and its writes never leave the
 * browser (see the sandbox handling in the stores). */
export const SANDBOX_ID = "developer-sandbox";
export const SANDBOX_NAME = "Developer (sandbox)";

export function accountByEmail(email: string): TeamAccount | undefined {
  const e = email.trim().toLowerCase();
  return TEAM_ACCOUNTS.find((a) => a.email === e);
}

export function accountById(id: string): TeamAccount | undefined {
  return TEAM_ACCOUNTS.find((a) => a.id === id);
}

/** Accounts a developer may enter, by the name they'd type at login. */
export function impersonationTargets(): { id: string; name: string; role: Role }[] {
  return [
    ...TEAM_ACCOUNTS.filter((a) => a.role === "rep" || a.role === "admin").map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
    })),
    { id: SANDBOX_ID, name: SANDBOX_NAME, role: "developer" as const },
  ];
}

/** Resolve a developer's chosen account to an impersonation target. Accepts
 * either an exact account id (what the login dropdown sends, e.g.
 * "stefano-nicoli" / "developer-sandbox") or a typed name/keyword ("stefano",
 * "Developer") for robustness. */
export function resolveImpersonationTarget(
  chosen: string,
): { id: string; name: string; role: Role; sandbox: boolean } | null {
  const q = chosen.trim().toLowerCase();
  if (!q) return null;

  // The sandbox — by id or keyword.
  if (q === SANDBOX_ID || q === "developer" || q === "sandbox" || q === "dev") {
    return { id: SANDBOX_ID, name: SANDBOX_NAME, role: "developer", sandbox: true };
  }

  // Exact account id (the normal path — the dropdown's option value).
  const byId = TEAM_ACCOUNTS.find(
    (a) => a.id === q && (a.role === "rep" || a.role === "admin"),
  );
  if (byId) return { id: byId.id, name: byId.name, role: byId.role, sandbox: false };

  // Fallback: fuzzy name / first-name / substring match on a typed value.
  for (const t of impersonationTargets()) {
    if (t.id === SANDBOX_ID) continue;
    const name = t.name.toLowerCase();
    const first = name.split(" ")[0];
    if (name === q || first === q || name.startsWith(q) || name.includes(q)) {
      return { id: t.id, name: t.name, role: t.role, sandbox: false };
    }
  }
  return null;
}

// ---- Capability helpers — the per-page scoping decisions in one place -------

/** Admins and developers see company-wide data (all customers, every rep's
 * calendar/activity, everyone's AI insights). Reps see only their own. */
export function seesEverything(role: Role): boolean {
  return role === "admin" || role === "developer";
}

/** Whether this role has a personal calendar/activity of their own. Reps do;
 * the developer sandbox does (an empty one, for testing); admins do NOT — they
 * only switch between the reps' calendars. */
export function hasOwnCalendar(role: Role, sandbox: boolean): boolean {
  return role === "rep" || sandbox;
}
