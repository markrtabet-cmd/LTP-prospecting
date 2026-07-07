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
}

function account(name: string, email: string, role: Role, aliases: string[]): TeamAccount {
  return { id: repSlug(name), name, email: email.toLowerCase(), role, aliases };
}

export const TEAM_ACCOUNTS: TeamAccount[] = [
  // ---- Sales reps ----
  account("Stefano Nicoli", "stefano.nicoli@latuapasta.com", "rep", ["Stefano"]),
  account("Turi Palumbo", "turi.palumbo@latuapasta.com", "rep", ["Turi"]),
  account("Luca Beschin", "luca.beschin@latuapasta.com", "rep", ["Luca"]),
  // ---- Admins (they manage accounts in Power BI too, so they carry aliases) ----
  account("Jessica Scudetti", "jessica.scudetti@latuapasta.com", "admin", ["Jessica"]),
  account("Nicolas Hanson", "nicolas.hanson@latuapasta.com", "admin", ["Nicolas"]),
  // ---- Developers ----
  account("Mark Tabet", "markrtabet@gmail.com", "developer", []),
  account("Theodore Hanson", "theodore.hanson44@gmail.com", "developer", []),
];

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

/** Resolve what a developer typed ("stefano", "Developer", "jessica scudetti")
 * to one of the impersonation targets. First-name / substring tolerant. */
export function resolveImpersonationTarget(
  typed: string,
): { id: string; name: string; role: Role; sandbox: boolean } | null {
  const q = typed.trim().toLowerCase();
  if (!q) return null;
  if (q === "developer" || q === "sandbox" || q === "dev") {
    return { id: SANDBOX_ID, name: SANDBOX_NAME, role: "developer", sandbox: true };
  }
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
