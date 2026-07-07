// Signed session cookie carrying the rep's identity. Uses Web Crypto only so
// the SAME code verifies in the Edge middleware and signs in Node API routes.
// Format: v1.<base64url payload JSON>.<base64url HMAC-SHA256 signature>

export type SessionRole = "rep" | "admin" | "developer";

export interface SessionIdentity {
  /** EFFECTIVE account id — slug of the name, e.g. "mark-tabet". When a
   * developer is impersonating someone, this is the TARGET's id, so all
   * per-rep scoping (calendars, customers, meetings) attributes to them. */
  id: string;
  name: string;
  /** Effective role — drives every access decision. Defaults to "rep" (least
   * privilege) on older cookies that predate this field. */
  role: SessionRole;
  /** Unix seconds expiry. */
  exp: number;
  /** Developer impersonation: the real developer behind the effective identity
   * (for the "viewing as …" banner). Absent for normal sign-ins. */
  realId?: string;
  realName?: string;
  /** True for the isolated developer test account — its writes never persist to
   * the shared database. */
  sandbox?: boolean;
}

export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function secret(): string {
  return process.env.SESSION_SECRET || process.env.SITE_PASSWORD || "latuapasta";
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(payload: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return new Uint8Array(sig);
}

/** Turn a rep name into a stable id: "Mark Tabet " → "mark-tabet". */
export function repSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function createSessionValue(
  id: string,
  name: string,
  extra: {
    role?: SessionRole;
    realId?: string;
    realName?: string;
    sandbox?: boolean;
  } = {},
): Promise<string> {
  const payload: SessionIdentity = {
    id,
    name,
    role: extra.role ?? "rep",
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
    ...(extra.realId ? { realId: extra.realId } : {}),
    ...(extra.realName ? { realName: extra.realName } : {}),
    ...(extra.sandbox ? { sandbox: true } : {}),
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(body));
  return `v1.${body}.${sig}`;
}

/** Verify a cookie value; null when missing/tampered/expired (including the
 * legacy "1" cookies from the shared-password era — those force a re-login). */
export async function verifySessionValue(value: string | undefined): Promise<SessionIdentity | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  const expected = b64url(await hmac(body));
  if (!timingSafeEqualStr(sig, expected)) return null;
  const bytes = fromB64url(body);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as SessionIdentity;
    if (!payload.id || !payload.name || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    // Older cookies predate `role` — default to the least-privileged rep view.
    if (payload.role !== "admin" && payload.role !== "developer") payload.role = "rep";
    return payload;
  } catch {
    return null;
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Password hashing (PBKDF2 via Web Crypto — no node:crypto import) -------

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const enc = new TextEncoder();
  const saltBytes = saltB64
    ? fromB64url(saltB64) ?? crypto.getRandomValues(new Uint8Array(16))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(saltBytes) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  return timingSafeEqualStr(computed.hash, hash);
}
