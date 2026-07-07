import { NextResponse } from "next/server";
import { resolveCfLoginIdentity } from "@/lib/login-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What should the login screen show? With a Cloudflare Access identity on the
// request, the app already knows who this is — the page greets them by name
// and asks only for their password. Without one (local dev, or Cloudflare not
// in front yet), the classic name+password form is used.
export async function GET(req: Request) {
  const cf = await resolveCfLoginIdentity(req);
  if (!cf) return NextResponse.json({ mode: "password" as const });
  return NextResponse.json({
    mode: "cf" as const,
    email: cf.email,
    name: cf.name,
    firstName: cf.firstName,
    hasPersonalPassword: Boolean(cf.rep?.passwordHash && cf.rep?.passwordSalt),
  });
}
