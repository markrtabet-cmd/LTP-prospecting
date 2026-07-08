// Activity notes live on the shared venue blob (so they sync across a rep's own
// devices), but a rep should only SEE the activity THEY logged — Turi must not
// see what Stefano logged. Admins and developers see everyone's.
//
// New notes carry `repId`; pre-login notes are matched by author name against
// the rep's Power BI aliases, so a rep still sees their own older notes.

import { normalizeName } from "./visits/match";
import type { ContactNote, Rep } from "./types";

export function noteBelongsToRep(note: ContactNote, rep: Rep): boolean {
  if (note.repId) return note.repId === rep.id;
  const author = normalizeName(note.author);
  if (!author) return false;
  return [rep.name, ...(rep.aliases ?? [])].some((c) => {
    const cn = normalizeName(c);
    return cn === author || author.includes(cn) || cn.includes(author);
  });
}

/** The notes this viewer is allowed to see: everyone's for admins/devs, only
 * their own for a rep. */
export function visibleNotes(
  log: ContactNote[] | undefined,
  opts: { rep: Rep | null; seesEverything: boolean },
): ContactNote[] {
  const all = log ?? [];
  if (opts.seesEverything) return all;
  if (!opts.rep) return [];
  return all.filter((n) => noteBelongsToRep(n, opts.rep!));
}
