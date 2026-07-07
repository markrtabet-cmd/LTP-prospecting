// "Who is at the door?" — resolves the Cloudflare Access identity for the
// login flow. When the app sits behind Cloudflare Zero Trust with email OTP,
// every request arrives with the visitor's VERIFIED company email; reading it
// here means the login page already knows it's Stefano ("Hello, Stefano") and
// only needs his password — nobody can even attempt another person's account
// without first passing that person's email OTP at Cloudflare.
//
// Trust levels:
//  - CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set → the Cf-Access-Jwt-Assertion
//    header is signature-verified (see cf-access.ts). Strongest: a request
//    with no valid Cloudflare-signed token gets NO identity (and the
//    middleware 403s it anyway).
//  - Not set → fall back to Cloudflare's plain Cf-Access-Authenticated-User-
//    Email header. Spoofable by anyone who can reach the origin directly
//    (e.g. the *.vercel.app URL), so it only ever picks WHICH account the
//    visitor may attempt — the account's password still decides entry, same
//    as today's typed-name flow. Set the two env vars to close this gap.

import { cfAccessConfigured, verifyAccessJwt } from "./cf-access";
import { repSlug } from "./session";
import { listReps } from "./users";
import type { Rep } from "./types";

export interface CfLoginIdentity {
  /** Lower-cased email Cloudflare authenticated. */
  email: string;
  /** True when it came from a signature-verified Access JWT. */
  verified: boolean;
  /** Roster account bound to this email via Rep.email (null until then). */
  rep: Rep | null;
  /** Account id/name the login will use — roster values when matched,
   * otherwise derived from the email ("stefano.nicoli@…" → "Stefano Nicoli"). */
  id: string;
  name: string;
  firstName: string;
}

/** "stefano.nicoli@latuapasta.com" → "Stefano Nicoli". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0]?.split("+")[0] ?? "";
  const parts = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  return parts.join(" ") || email;
}

export async function resolveCfLoginIdentity(req: Request): Promise<CfLoginIdentity | null> {
  let email = "";
  let verified = false;

  if (cfAccessConfigured()) {
    // Verification configured: ONLY a valid Cloudflare-signed token counts.
    const jwt = req.headers.get("cf-access-jwt-assertion");
    const payload = jwt ? await verifyAccessJwt(jwt) : null;
    if (!payload?.email) return null;
    email = payload.email;
    verified = true;
  } else {
    email = req.headers.get("cf-access-authenticated-user-email")?.trim() ?? "";
    if (!email) return null;
  }

  email = email.toLowerCase();
  const reps = await listReps();
  const rep = reps.find((r) => r.email && r.email.toLowerCase() === email) ?? null;
  const name = rep?.name ?? nameFromEmail(email);
  const id = rep?.id ?? repSlug(name);
  if (!id) return null;
  return { email, verified, rep, id, name, firstName: name.split(" ")[0] || name };
}
