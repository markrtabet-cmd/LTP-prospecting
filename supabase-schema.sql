-- La Tua Pasta prospecting tool — shared team data.
-- Run this once in your Supabase project: Dashboard → SQL Editor → paste → Run.
--
-- These two tables hold the SHARED state (added venues + per-venue edits).
-- The base 20k London venues are served from public/london-restaurants.json and
-- are NOT stored here. All access goes through the app's server (service-role
-- key), so we lock the tables down with RLS and add no public policies.

create table if not exists ltp_added (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists ltp_overrides (
  id text primary key,
  patch jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock down: enable RLS with no policies → the anon/public key cannot read or
-- write. The server uses the service-role key, which bypasses RLS.
alter table ltp_added enable row level security;
alter table ltp_overrides enable row level security;

-- ---- Meeting calendar (per-rep visits) --------------------------------------
-- Run this block too (safe to re-run). Same locked-down JSONB pattern.

-- Sales team roster: one row per rep (id = name slug). data holds name,
-- Power BI account-manager aliases and an optional PBKDF2 password hash.
create table if not exists ltp_users (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

-- Calendar meetings: one row per meeting (scheduled / completed / missed /
-- cancelled). data holds repId, venueId, date, status, locked, source, AI
-- summary etc. Audio + transcripts live in the "meeting-media" Storage bucket
-- (created automatically by the app, private); only object paths are stored.
create table if not exists ltp_meetings (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

alter table ltp_users enable row level security;
alter table ltp_meetings enable row level security;
