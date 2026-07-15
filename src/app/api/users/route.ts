import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase";
import { hashPassword, repSlug, verifySessionValue } from "@/lib/session";
import { getRep, listReps, removeRep, toPublicRep, upsertRep } from "@/lib/users";
import type { Rep } from "@/lib/types";

export const runtime = "nodejs";
// Prevents this GET from being eligible for Next.js's automatic static
// caching, which would otherwise let one cached roster snapshot keep being
// served to every rep even after Team Settings adds/edits someone.
export const dynamic = "force-dynamic";

// Sales-team roster. Session-gated by middleware like everything else — any
// signed-in rep can manage the team (small trusted team; tighten later if an
// admin role ever exists). Password hashes never leave the server.

export async function GET() {
  const reps = await listReps();
  return NextResponse.json({
    configured: isSupabaseConfigured(),
    users: reps.map(toPublicRep),
  });
}

export async function POST(req: Request) {
  let body: {
    op?: string;
    id?: string;
    name?: string;
    aliases?: string[];
    password?: string;
    signature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // A rep updates their OWN email signature. The target rep is always the
  // session identity — a client can never set someone else's signature.
  if (body.op === "setSignature") {
    const session = await verifySessionValue(cookies().get(SESSION_COOKIE)?.value);
    if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    // Sandbox developer account: writes stay in the browser (localStorage).
    if (session.sandbox || !isSupabaseConfigured()) {
      return NextResponse.json({ ok: false, configured: false });
    }
    const existing = await getRep(session.id);
    if (!existing) return NextResponse.json({ ok: false, configured: false });
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    const result = await upsertRep({ ...existing, signature: signature || undefined });
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.op === "upsert" && body.name?.trim()) {
    const name = body.name.trim();
    const id = body.id?.trim() || repSlug(name);
    if (!id) return NextResponse.json({ ok: false, error: "bad_name" }, { status: 400 });
    const existing = await getRep(id);
    const rep: Rep = {
      id,
      name,
      aliases: (body.aliases ?? existing?.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      signature: existing?.signature,
      passwordHash: existing?.passwordHash,
      passwordSalt: existing?.passwordSalt,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (body.password?.trim()) {
      const { hash, salt } = await hashPassword(body.password.trim());
      rep.passwordHash = hash;
      rep.passwordSalt = salt;
    }
    const result = await upsertRep(rep);
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    return NextResponse.json({ ok: true, user: toPublicRep(rep) });
  }

  if (body.op === "remove" && body.id) {
    const result = await removeRep(body.id);
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
}
