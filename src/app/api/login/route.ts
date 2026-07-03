import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { createSessionValue, repSlug, SESSION_MAX_AGE_S, verifyPassword } from "@/lib/session";
import { getRep } from "@/lib/users";

export const runtime = "nodejs";

// Per-rep sign-in: name + password. Reps with their own password (set in
// Settings → Sales team) use it; everyone else uses the shared SITE_PASSWORD.
// Either way the cookie carries a signed identity, so meetings, calendars and
// contact notes know who did what.
export async function POST(req: Request) {
  let name = "";
  let password = "";
  try {
    const body = await req.json();
    name = String(body?.name ?? "").trim();
    password = String(body?.password ?? "");
  } catch {
    /* empty */
  }

  if (!name || !password) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }
  const id = repSlug(name);
  if (!id) {
    return NextResponse.json({ ok: false, error: "bad_name" }, { status: 400 });
  }

  const sharedPassword = process.env.SITE_PASSWORD || "latuapasta";
  const rep = await getRep(id);

  let valid = false;
  if (rep?.passwordHash && rep.passwordSalt) {
    valid = await verifyPassword(password, rep.passwordHash, rep.passwordSalt);
  } else {
    // No personal password set (or no roster yet) → shared password signs in.
    valid = password === sharedPassword;
  }
  if (!valid) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, id, name: rep?.name ?? name });
  res.cookies.set(SESSION_COOKIE, await createSessionValue(id, rep?.name ?? name), {
    httpOnly: true,
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
