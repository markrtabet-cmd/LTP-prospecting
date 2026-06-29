import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// Verify the shared site password and set the session cookie.
export async function POST(req: Request) {
  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "");
  } catch {
    /* empty */
  }

  // Set SITE_PASSWORD in .env.local / Vercel. Falls back to a dev default so the
  // app is usable locally before you configure it — CHANGE THIS in production.
  const expected = process.env.SITE_PASSWORD || "latuapasta";

  if (!password || password !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "1", {
    httpOnly: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
