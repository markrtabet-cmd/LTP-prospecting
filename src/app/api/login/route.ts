import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import {
  createSessionValue,
  repSlug,
  SESSION_MAX_AGE_S,
  timingSafeEqualStr,
  verifyPassword,
} from "@/lib/session";
import { getRep } from "@/lib/users";
import { resolveCfLoginIdentity } from "@/lib/login-identity";

export const runtime = "nodejs";

// Brute-force damping. Per-instance memory (serverless instances each keep
// their own map), so this blunts guessing rather than hard-stopping it —
// pair with a WAF rate-limit rule on /api/login for volume attacks.
const failures = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 10;

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip") ?? "unknown").trim();
}

function recentFailures(key: string): number[] {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-rep sign-in: password against a known identity. Who the identity is
// comes from Cloudflare Access when the app sits behind it (the email OTP
// already proved who's at the door, so the typed name is IGNORED — you can
// only sign into your own account); otherwise from the typed name, as before.
// Reps with their own password (set in Settings → Sales team) use it; everyone
// else uses the shared SITE_PASSWORD. Either way the cookie carries a signed
// identity, so meetings, calendars and contact notes know who did what.
export async function POST(req: Request) {
  const cf = await resolveCfLoginIdentity(req);

  let name = "";
  let password = "";
  try {
    const body = await req.json();
    name = String(body?.name ?? "").trim();
    password = String(body?.password ?? "");
  } catch {
    /* empty */
  }
  if (cf) name = cf.name; // identity is Cloudflare's call, not the client's

  if (!name || !password) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }
  const id = cf?.id ?? repSlug(name);
  if (!id) {
    return NextResponse.json({ ok: false, error: "bad_name" }, { status: 400 });
  }

  const key = clientKey(req);
  if (recentFailures(key).length >= MAX_FAILURES_PER_WINDOW) {
    await sleep(1000);
    return NextResponse.json(
      { ok: false, error: "Too many attempts — wait 10 minutes and try again." },
      { status: 429 },
    );
  }

  const sharedPassword = process.env.SITE_PASSWORD || "latuapasta";
  const rep = cf?.rep ?? (await getRep(id));

  let valid = false;
  if (rep?.passwordHash && rep.passwordSalt) {
    valid = await verifyPassword(password, rep.passwordHash, rep.passwordSalt);
  } else {
    // No personal password set (or no roster yet) → shared password signs in.
    valid = timingSafeEqualStr(password, sharedPassword);
  }
  if (!valid) {
    recentFailures(key).push(Date.now());
    await sleep(400); // make each wrong guess cost real time
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  failures.delete(key);

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
