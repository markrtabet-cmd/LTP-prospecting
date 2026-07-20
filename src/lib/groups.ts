// Owner / operator "customer groups" — multiple venues run by the same people,
// sourced from Power BI's Customer Group field (Restaurant.ownerGroup, wired in
// src/lib/customer-sync.ts via POWERBI_OWNER_GROUP_COLUMN). This is DISTINCT
// from the name-based chain grouping in src/lib/chains.ts: that recognises a
// brand from a venue's name; this reflects who actually operates the account.
//
// A group can be visited two ways (GroupVisitSettings, chosen by a rep on any
// member's profile and replicated onto every member via updateMany):
//   • "each"        — every member keeps its own visit rhythm (default).
//   • "head_office" — only the nominated head office is scheduled/suggested;
//                     the other members drop out of the calendar's rhythm
//                     suggestions (a rep sees the group by visiting head office).
//
// Membership + head-office designation are derived fresh from the in-memory
// customer list, so nothing here is persisted beyond ownerGroup (from Power BI)
// and groupVisit (the rep's choice, on each member).

import type { GroupVisitSettings, Restaurant } from "./types";

const DEFAULT_VISIT: GroupVisitSettings = { mode: "each", headOfficeId: null };

/** This customer's owner group as a display string, or null when ungrouped. */
export function ownerGroupName(r: Restaurant): string | null {
  const g = (r.ownerGroup ?? "").trim();
  return g || null;
}

/** Case-insensitive key so "Soho House" and "SOHO HOUSE" group together. */
function groupKey(name: string): string {
  return name.trim().toUpperCase();
}

export interface OwnerGroup {
  /** Display name (first member's spelling of the group). */
  name: string;
  key: string;
  /** Every customer in the group, sorted by name. Always >= 1. */
  members: Restaurant[];
  /** Resolved group visit plan (mode + head office). */
  visit: GroupVisitSettings;
  /** The head-office member when mode is "head_office" and it resolves, else null. */
  headOffice: Restaurant | null;
  /** True only when there's more than one member — a real multi-site group. */
  isMultiSite: boolean;
}

/** Resolve the group's visit settings from its members. They're replicated, but
 * be defensive: prefer a member that actually names a head office, then any
 * member with settings, else the default. */
function resolveVisit(members: Restaurant[]): GroupVisitSettings {
  const withHead = members.find((m) => m.groupVisit?.mode === "head_office" && m.groupVisit.headOfficeId);
  if (withHead?.groupVisit) return withHead.groupVisit;
  const anySet = members.find((m) => m.groupVisit);
  return anySet?.groupVisit ?? DEFAULT_VISIT;
}

/** Build every owner group present in `list` (ungrouped customers are omitted). */
export function buildOwnerGroups(list: Restaurant[]): Map<string, OwnerGroup> {
  const byKey = new Map<string, Restaurant[]>();
  for (const r of list) {
    const name = ownerGroupName(r);
    if (!name) continue;
    const k = groupKey(name);
    const arr = byKey.get(k);
    if (arr) arr.push(r);
    else byKey.set(k, [r]);
  }
  const out = new Map<string, OwnerGroup>();
  byKey.forEach((members, key) => {
    members.sort((a, b) => a.name.localeCompare(b.name));
    const visit = resolveVisit(members);
    const headOffice =
      visit.mode === "head_office" && visit.headOfficeId
        ? members.find((m) => m.id === visit.headOfficeId) ?? null
        : null;
    out.set(key, {
      name: ownerGroupName(members[0]) ?? members[0].name,
      key,
      members,
      visit,
      headOffice,
      isMultiSite: members.length > 1,
    });
  });
  return out;
}

/** The owner group a specific customer belongs to (with all members), or null. */
export function groupOf(r: Restaurant, all: Restaurant[]): OwnerGroup | null {
  const name = ownerGroupName(r);
  if (!name) return null;
  return buildOwnerGroups(all).get(groupKey(name)) ?? null;
}

/** Is this customer the nominated head office of a head-office-only group? */
export function isHeadOffice(r: Restaurant, all: Restaurant[]): boolean {
  const g = groupOf(r, all);
  return !!g && g.headOffice?.id === r.id;
}

// A precomputed lookup for hot paths (calendar suggestions, map render) that
// classify many venues at once — avoids rebuilding the group map per venue.
export interface GroupIndex {
  /** venue id → its group key. */
  keyByVenue: Map<string, string>;
  groups: Map<string, OwnerGroup>;
  /** Head-office venue ids (across all head-office-only groups). */
  headOfficeIds: Set<string>;
  /** Venue ids whose RHYTHM visits are suppressed: non-head-office members of a
   * head-office-only group. They're still real customers (sales-health alerts
   * still fire); they just stop getting their own cadence-driven suggestions. */
  rhythmSuppressedIds: Set<string>;
}

export function buildGroupIndex(all: Restaurant[]): GroupIndex {
  const groups = buildOwnerGroups(all);
  const keyByVenue = new Map<string, string>();
  const headOfficeIds = new Set<string>();
  const rhythmSuppressedIds = new Set<string>();
  groups.forEach((g) => {
    for (const m of g.members) keyByVenue.set(m.id, g.key);
    if (g.visit.mode === "head_office" && g.headOffice) {
      headOfficeIds.add(g.headOffice.id);
      for (const m of g.members) if (m.id !== g.headOffice.id) rhythmSuppressedIds.add(m.id);
    }
  });
  return { keyByVenue, groups, headOfficeIds, rhythmSuppressedIds };
}

/** True when this venue is a NON-head-office member of a head-office-only group,
 * so its own rhythm / sales suggestions are suppressed (the rep covers it by
 * visiting the head office). Reads the replicated groupVisit on the venue
 * itself, so it works per-venue without the full customer list — handy in the
 * calendar's hot path. */
export function isVisitSuppressedMember(r: Restaurant): boolean {
  const gv = r.groupVisit;
  return !!gv && gv.mode === "head_office" && !!gv.headOfficeId && gv.headOfficeId !== r.id;
}

/** True when this venue is the nominated head office of a head-office-only group
 * (from its own replicated groupVisit). */
export function isGroupHeadOffice(r: Restaurant): boolean {
  const gv = r.groupVisit;
  return !!gv && gv.mode === "head_office" && gv.headOfficeId === r.id;
}

/** The updateMany payload that writes `settings` onto every member of a group,
 * so the whole group agrees. Clears headOfficeId when switching back to "each".
 */
export function groupVisitPatch(
  members: Restaurant[],
  settings: GroupVisitSettings,
): Record<string, Partial<Restaurant>> {
  const normalized: GroupVisitSettings =
    settings.mode === "head_office"
      ? { mode: "head_office", headOfficeId: settings.headOfficeId ?? null }
      : { mode: "each", headOfficeId: null };
  const patches: Record<string, Partial<Restaurant>> = {};
  for (const m of members) patches[m.id] = { groupVisit: normalized };
  return patches;
}
