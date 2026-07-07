// Seed the fixed La Tua Pasta team into the ltp_users roster (3 reps, 2 admins,
// 2 developers). Each gets the starter password "latuapasta", hashed exactly
// the way src/lib/session.ts verifies it (PBKDF2-SHA256, 100k iterations,
// 16-byte salt, base64url) so personal-password sign-in works immediately.
//
// Idempotent — safe to re-run; it upserts by id. Reads Supabase creds from
// .env.local. Run: node scripts/seed-team.mjs
//
// Keep this list in sync with src/lib/team-accounts.ts (the app's source of
// truth); this script is just the one-off writer for the shared database.

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const STARTER_PASSWORD = "latuapasta";

// Mirrors repSlug() in src/lib/session.ts.
function repSlug(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Mirrors hashPassword() in src/lib/session.ts (PBKDF2-SHA256, 100k, 32 bytes,
// base64url — no padding). WebCrypto and Node produce identical output here.
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  return { passwordHash: hash.toString("base64url"), passwordSalt: salt.toString("base64url") };
}

function account(name, email, role, aliases) {
  return { id: repSlug(name), name, email: email.toLowerCase(), role, aliases };
}

const ACCOUNTS = [
  account("Stefano Nicoli", "stefano.nicoli@latuapasta.com", "rep", ["Stefano"]),
  account("Turi Palumbo", "turi.palumbo@latuapasta.com", "rep", ["Turi"]),
  account("Luca Beschin", "luca.beschin@latuapasta.com", "rep", ["Luca"]),
  account("Jessica Scudetti", "jessica.scudetti@latuapasta.com", "admin", ["Jessica"]),
  account("Nicolas Hanson", "nicolas.hanson@latuapasta.com", "admin", ["Nicolas"]),
  account("Mark Tabet", "markrtabet@gmail.com", "developer", []),
  account("Theodore Hanson", "theodore.hanson44@gmail.com", "developer", []),
];

const now = new Date().toISOString();
const rows = ACCOUNTS.map((a) => {
  const { passwordHash, passwordSalt } = hashPassword(STARTER_PASSWORD);
  return {
    id: a.id,
    data: {
      id: a.id,
      name: a.name,
      email: a.email,
      role: a.role,
      aliases: a.aliases,
      passwordHash,
      passwordSalt,
      createdAt: now,
    },
  };
});

const res = await fetch(`${URL}/rest/v1/ltp_users`, {
  method: "POST",
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=representation",
  },
  body: JSON.stringify(rows),
});

if (!res.ok) {
  console.error(`Upsert failed: ${res.status}\n${await res.text()}`);
  process.exit(1);
}

const saved = await res.json();
console.log(`Seeded ${saved.length} accounts (password "${STARTER_PASSWORD}"):`);
for (const r of saved) {
  const d = r.data;
  console.log(`  ${d.role.padEnd(9)} ${d.name.padEnd(18)} ${d.email}  aliases=[${(d.aliases || []).join(", ")}]`);
}
