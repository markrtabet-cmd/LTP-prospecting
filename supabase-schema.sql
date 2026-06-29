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
