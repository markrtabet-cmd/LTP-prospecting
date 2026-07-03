import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";

export const runtime = "nodejs";

// Who is signed in on this device. The browser can't read the httpOnly cookie,
// so the UI asks here once per load (see src/lib/rep.tsx).
export async function GET() {
  const value = cookies().get(SESSION_COOKIE)?.value;
  const session = await verifySessionValue(value);
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, id: session.id, name: session.name });
}
