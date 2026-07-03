// Cloudflare Access enforcement. When the app sits behind Cloudflare Zero
// Trust, every legitimate request carries a Cf-Access-Jwt-Assertion header
// signed by Cloudflare. Verifying it in middleware means the *.vercel.app
// URLs can't be used to sneak around Cloudflare — requests that didn't pass
// the Access login get a 403 regardless of which hostname they hit.
//
// Opt-in: enforcement only runs when BOTH env vars are set —
//   CF_ACCESS_TEAM_DOMAIN  e.g. "latuapasta.cloudflareaccess.com"
//   CF_ACCESS_AUD          the Access application's Audience (AUD) tag
// Web Crypto only (runs in Edge middleware).

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface AccessPayload {
  aud: string[] | string;
  exp: number;
  iss: string;
  email?: string;
}

export function cfAccessConfigured(): boolean {
  return Boolean(process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD);
}

// Cloudflare rotates signing keys rarely; cache the JWKS for an hour and
// refetch once on an unknown kid.
let jwksCache: { keys: AccessJwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string, forceRefresh = false): Promise<AccessJwk[]> {
  const now = Date.now();
  if (!forceRefresh && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const data = (await res.json()) as { keys?: AccessJwk[] };
  jwksCache = { keys: data.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

function b64urlToBytes(s: string): Uint8Array | null {
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

function decodeJson<T>(b64url: string): T | null {
  const bytes = b64urlToBytes(b64url);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** Verify a Cloudflare Access JWT (RS256): signature, audience, expiry,
 * issuer. Returns the payload (with the user's email) or null. */
export async function verifyAccessJwt(token: string): Promise<AccessPayload | null> {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJson<{ kid?: string; alg?: string }>(headerB64);
  const payload = decodeJson<AccessPayload>(payloadB64);
  const sig = b64urlToBytes(sigB64);
  if (!header?.kid || header.alg !== "RS256" || !payload || !sig) return null;

  // Claims first — cheap rejects before any crypto.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;

  try {
    let keys = await getJwks(teamDomain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await getJwks(teamDomain, true); // key rotation → one forced refetch
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig as BufferSource,
      data,
    );
    return valid ? payload : null;
  } catch {
    return null;
  }
}
