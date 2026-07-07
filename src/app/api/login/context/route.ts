import { NextResponse } from "next/server";
import { resolveCfLoginIdentity } from "@/lib/login-identity";
import { impersonationTargets } from "@/lib/team-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What should the login screen show?
//  - Cloudflare identity that's a rep/admin → greet by name, ask only for a
//    password (they can only ever be themselves).
//  - Cloudflare identity that's a developer → greet by name, but let them pick
//    which account to enter (any rep/admin, or the sandbox) before the password.
//  - No Cloudflare identity (local dev) → the classic name+password form.
export async function GET(req: Request) {
  const cf = await resolveCfLoginIdentity(req);
  if (!cf) return NextResponse.json({ mode: "password" as const });

  if (cf.isDeveloper) {
    return NextResponse.json({
      mode: "cf-developer" as const,
      email: cf.email,
      name: cf.name,
      firstName: cf.firstName,
      targets: impersonationTargets(),
    });
  }

  return NextResponse.json({
    mode: "cf" as const,
    email: cf.email,
    name: cf.name,
    firstName: cf.firstName,
    role: cf.role,
    hasPersonalPassword: Boolean(cf.rep?.passwordHash && cf.rep?.passwordSalt),
  });
}
