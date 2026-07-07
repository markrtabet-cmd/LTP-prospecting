import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import {
  createSessionValue,
  repSlug,
  SESSION_MAX_AGE_S,
  timingSafeEqualStr,
  verifyPassword,
  type SessionRole,
} from "@/lib/session";
import { getRep } from "@/lib/users";
import { resolveCfLoginIdentity } from "@/lib/login-identity";
import { accountById, resolveImpersonationTarget } from "@/lib/team-accounts";

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
  let target = "";
  try {
    const body = await req.json();
    name = String(body?.name ?? "").trim();
    password = String(body?.password ?? "");
    target = String(body?.target ?? "").trim(); // developer's chosen account
  } catch {
    /* empty */
  }
  if (cf) name = cf.name; // identity is Cloudflare's call, not the client's

  if (!name || !password) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  // WHO owns the credential we check (always the person actually at the door),
  // vs. the EFFECTIVE identity we sign them in as (differs only when a
  // developer impersonates someone).
  const credentialId = cf?.id ?? repSlug(name);
  if (!credentialId) {
    return NextResponse.json({ ok: false, error: "bad_name" }, { status: 400 });
  }

  // A developer identified by Cloudflare must pick which account to enter; that
  // becomes the effective identity. Everyone else is simply themselves. (In
  // local dev with no Cloudflare identity there's no picker, so a typed
  // developer name just signs in as a plain developer.)
  let effectiveId = credentialId;
  let effectiveName = cf?.name ?? name;
  let effectiveRole: SessionRole = cf?.role ?? accountById(credentialId)?.role ?? "rep";
  let sandbox = false;
  const impersonating = Boolean(cf?.isDeveloper);

  if (impersonating) {
    const chosen = resolveImpersonationTarget(target);
    if (!chosen) {
      return NextResponse.json({ ok: false, error: "choose_account" }, { status: 400 });
    }
    effectiveId = chosen.id;
    effectiveName = chosen.name;
    effectiveRole = chosen.role;
    sandbox = chosen.sandbox;
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
  // The password checked is the CREDENTIAL owner's — a developer authorises
  // impersonation with their OWN password, never the target's.
  const credentialRep = cf?.rep ?? (await getRep(credentialId));

  let valid = false;
  if (credentialRep?.passwordHash && credentialRep.passwordSalt) {
    valid = await verifyPassword(password, credentialRep.passwordHash, credentialRep.passwordSalt);
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

  const res = NextResponse.json({ ok: true, id: effectiveId, name: effectiveName, role: effectiveRole });
  res.cookies.set(
    SESSION_COOKIE,
    await createSessionValue(effectiveId, effectiveName, {
      role: effectiveRole,
      sandbox,
      // Record the real developer behind an impersonated session (for the banner).
      ...(impersonating ? { realId: credentialId, realName: cf?.name ?? name } : {}),
    }),
    {
      httpOnly: true,
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  );
  return res;
}
