import type { Restaurant } from "./types";

// Chain / duplicate grouping + branding.
//
// Two jobs:
//  1. detectChain(name) — recognise a venue as belonging to a KNOWN restaurant
//     chain (Ask Italian, Pizza Express, Nando's, …) from a curated brand
//     registry. This is reliable: it works on a single venue, regardless of how
//     many branches are in the current view, and tolerates name variants
//     ("Ask Italian", "Ask Italian The O2", "PizzaExpress").
//  2. groupChains(list) — collapse repeat stores into one row: first by known
//     brand, then (fallback) by a normalised name key so accidental duplicates
//     and un-listed chains still group.

// Normalise a venue name to lowercase alphanumeric tokens (accents stripped).
export function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (e.g. cafe accent -> e)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Curated registry of restaurant/cafe chains operating in London. Each entry has
// a canonical display name and one or more aliases. An alias matches when it
// equals the LEADING whole tokens of the venue name (so "leon" matches "Leon
// Bankside" but NOT "Leonardo's"). Add brands here to extend coverage.
const CHAIN_DEFS: { name: string; aliases: string[] }[] = [
  { name: "Ask Italian", aliases: ["ask italian", "askitalian"] },
  { name: "Pizza Express", aliases: ["pizza express", "pizzaexpress"] },
  { name: "Zizzi", aliases: ["zizzi"] },
  { name: "Prezzo", aliases: ["prezzo"] },
  { name: "Bella Italia", aliases: ["bella italia"] },
  { name: "Carluccio's", aliases: ["carluccios", "carluccio s", "carluccio"] },
  { name: "Strada", aliases: ["strada"] },
  { name: "Franco Manca", aliases: ["franco manca", "francomanca"] },
  { name: "Rossopomodoro", aliases: ["rossopomodoro"] },
  { name: "Vapiano", aliases: ["vapiano"] },
  { name: "Pizza Hut", aliases: ["pizza hut"] },
  { name: "Pizza Union", aliases: ["pizza union"] },
  { name: "Pizza Pilgrims", aliases: ["pizza pilgrims"] },
  { name: "Pasta Evangelists", aliases: ["pasta evangelists"] },
  { name: "Côte", aliases: ["cote brasserie", "cote"] },
  { name: "Café Rouge", aliases: ["cafe rouge"] },
  { name: "Bill's", aliases: ["bills", "bill s"] },
  { name: "Giraffe", aliases: ["giraffe"] },
  { name: "Las Iguanas", aliases: ["las iguanas"] },
  { name: "Wahaca", aliases: ["wahaca"] },
  { name: "Wagamama", aliases: ["wagamama"] },
  { name: "Nando's", aliases: ["nandos", "nando s"] },
  { name: "Byron", aliases: ["byron"] },
  { name: "Five Guys", aliases: ["five guys"] },
  { name: "Honest Burgers", aliases: ["honest burgers", "honest burger"] },
  { name: "Gourmet Burger Kitchen", aliases: ["gourmet burger kitchen", "gbk", "gourmet burger"] },
  { name: "Burger King", aliases: ["burger king"] },
  { name: "McDonald's", aliases: ["mcdonalds", "mcdonald s"] },
  { name: "KFC", aliases: ["kfc"] },
  { name: "Wingstop", aliases: ["wingstop"] },
  { name: "Dishoom", aliases: ["dishoom"] },
  { name: "Wasabi", aliases: ["wasabi"] },
  { name: "Itsu", aliases: ["itsu"] },
  { name: "Yo! Sushi", aliases: ["yo sushi", "yosushi"] },
  { name: "Tortilla", aliases: ["tortilla"] },
  { name: "Chipotle", aliases: ["chipotle"] },
  { name: "Leon", aliases: ["leon"] },
  { name: "Pret A Manger", aliases: ["pret a manger", "pret"] },
  { name: "Costa Coffee", aliases: ["costa coffee", "costa"] },
  { name: "Caffè Nero", aliases: ["caffe nero", "cafe nero"] },
  { name: "Gail's Bakery", aliases: ["gails bakery", "gail s bakery", "gails", "gail s"] },
  { name: "Greggs", aliases: ["greggs"] },
  { name: "Subway", aliases: ["subway"] },
  { name: "Domino's Pizza", aliases: ["dominos pizza", "domino s pizza", "dominos", "domino s"] },
];

// Pre-tokenised aliases, longest first so the most specific brand wins.
const ALIAS_INDEX: { name: string; tokens: string[] }[] = CHAIN_DEFS.flatMap((d) =>
  d.aliases.map((a) => ({ name: d.name, tokens: normName(a).split(" ").filter(Boolean) }))
).sort((a, b) => b.tokens.length - a.tokens.length);

// Memo caches keyed by raw name. Venue names are effectively static and are
// re-scanned on every store recompute (a note save re-runs chain detection over
// the whole dataset), so caching name→result turns those repeated NFD+regex
// passes into cheap Map lookups. Bounded by the number of distinct venue names.
const detectChainCache = new Map<string, string | null>();
const chainKeyCache = new Map<string, string>();

/**
 * Return the canonical chain brand a venue belongs to, or null if it's not a
 * recognised chain. Matches an alias against the venue name's leading tokens.
 */
export function detectChain(name: string): string | null {
  const cached = detectChainCache.get(name);
  if (cached !== undefined) return cached;
  const result = computeDetectChain(name);
  detectChainCache.set(name, result);
  return result;
}

function computeDetectChain(name: string): string | null {
  const tokens = normName(name).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  for (const { name: brand, tokens: at } of ALIAS_INDEX) {
    if (at.length > tokens.length) continue;
    let ok = true;
    for (let i = 0; i < at.length; i++) {
      if (tokens[i] !== at[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return brand; // ALIAS_INDEX is longest-first, so this is the most specific match
  }
  return null;
}

// Common London areas/boroughs that appear as trailing branch labels. Used by
// the fallback name key so "Vinoteca Chiswick" and "Vinoteca Soho" still group.
const AREA_SUFFIXES = new Set([
  "soho","shoreditch","brixton","islington","camden","chiswick","clapham","ealing",
  "fulham","greenwich","hackney","hammersmith","hampstead","holborn","kensington",
  "mayfair","peckham","putney","richmond","stratford","tooting","wandsworth",
  "wimbledon","battersea","balham","bermondsey","blackheath","dalston","fitzrovia",
  "marylebone","pimlico","victoria","westminster","whitechapel","angel","bank",
  "borough","canary wharf","city","covent garden","kings cross","kingscross",
  "london bridge","notting hill","oxford circus","piccadilly","spitalfields","st pauls",
  "tower bridge","waterloo","wapping","aldgate","bayswater","bloomsbury","chelsea",
  "earls court","euston","farringdon","liverpool street","moorgate","paddington",
  "shepherds bush","vauxhall","white city","croydon","wembley","harrow","ilford",
  "romford","kingston","sutton","bromley","barnet","enfield","hounslow","uxbridge",
]);

const NOISE = /\b(ltd|limited|plc|llp|uk|the|restaurant|restaurants|pizzeria|cafe|caffe|kitchen|co)\b/g;

/** Grouping key: known brand first, else a conservative normalised name. */
export function chainKey(name: string): string {
  const cached = chainKeyCache.get(name);
  if (cached !== undefined) return cached;
  const computed = computeChainKey(name);
  chainKeyCache.set(name, computed);
  return computed;
}

function computeChainKey(name: string): string {
  const brand = detectChain(name);
  if (brand) return `brand:${normName(brand)}`;

  let s = (name || "").toLowerCase();
  // Cut everything after an explicit branch separator: - – — @ | • : ,  /
  s = s.split(/\s[-–—@|•:/]\s|\s[-–—@|•]/)[0];
  s = s.replace(/\(.*?\)/g, " "); // drop parentheticals
  s = s.replace(/['’`".,&]/g, " ").replace(/\s+/g, " ").trim();
  // Strip a trailing area/borough token (or two-word area) if one remains.
  for (let pass = 0; pass < 2; pass++) {
    const words = s.split(" ");
    if (words.length < 2) break;
    const last1 = words[words.length - 1];
    const last2 = `${words[words.length - 2]} ${last1}`;
    if (AREA_SUFFIXES.has(last2) && words.length > 2) {
      s = words.slice(0, -2).join(" ");
    } else if (AREA_SUFFIXES.has(last1)) {
      s = words.slice(0, -1).join(" ");
    } else {
      break;
    }
  }
  const stripped = s.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  return stripped || s;
}

export interface ChainGroup {
  key: string;
  /** Display name for the group (brand name when known, else the bare name). */
  name: string;
  /** Canonical brand when this group is a recognised chain. */
  brand: string | null;
  members: Restaurant[];
  /** True when this is a real multi-site chain / duplicate set (members > 1). */
  isChain: boolean;
}

// Cleanest brand label for a group: known brand wins; otherwise the shortest
// member name (usually the bare "Franco Manca" over "Franco Manca - Brixton").
function brandName(members: Restaurant[], brand: string | null): string {
  if (brand) return brand;
  return members
    .map((m) => m.name.trim())
    .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/** Group a list of restaurants into chains + singletons, preserving every venue. */
export function groupChains(list: Restaurant[]): ChainGroup[] {
  const map = new Map<string, Restaurant[]>();
  for (const r of list) {
    const k = chainKey(r.name);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  const groups: ChainGroup[] = Array.from(map.entries(), ([key, members]) => {
    members.sort((a, b) => a.borough.localeCompare(b.borough) || a.name.localeCompare(b.name));
    const brand = key.startsWith("brand:") ? detectChain(members[0].name) : null;
    return { key, name: brandName(members, brand), brand, members, isChain: members.length > 1 };
  });
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}
