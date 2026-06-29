import { CUISINES } from "./mock-data";
import { areaToBorough } from "./openings";
import type { Restaurant } from "./types";

// Shared filter resolution + matching so the assistant's "show me X" always maps
// to a REAL category (closest match) and reports an accurate count — and the
// Leads/Map views match the same way.

export interface AppliedFilter {
  // Multiple cuisines / boroughs can be active at once (OR within each group).
  cuisines?: string[];
  boroughs?: string[];
  text?: string;
  recommendedOnly?: boolean;
  existingCustomerOnly?: boolean;
  // When the user explicitly asks to see a category/text, show poor-fit
  // ("excluded") venues too instead of hiding them.
  includeExcluded?: boolean;
}

// Free-text cuisine → a known CUISINES name (or null if we can't map it).
const CUISINE_SYNONYMS: Record<string, string> = {
  lebanese: "Middle Eastern", turkish: "Middle Eastern", persian: "Middle Eastern",
  "middle eastern": "Middle Eastern", "middle-eastern": "Middle Eastern", mezze: "Middle Eastern",
  pizza: "Pizza & Pasta", pizzeria: "Pizza & Pasta",
  pasta: "Italian", trattoria: "Italian", osteria: "Italian", ristorante: "Italian", "modern italian": "Italian",
  med: "Mediterranean", mediterranean: "Mediterranean",
  "modern european": "Modern European", european: "Modern European", "fine dining": "Modern European",
  french: "French", bistro: "French", brasserie: "French",
  spanish: "Spanish / Tapas", tapas: "Spanish / Tapas",
  greek: "Greek",
  british: "British", gastropub: "Gastro-pub", "gastro pub": "Gastro-pub", pub: "Gastro-pub",
  steak: "Steakhouse", steakhouse: "Steakhouse", grill: "Steakhouse",
  seafood: "Seafood", fish: "Seafood",
  deli: "Deli / Mediterranean", delicatessen: "Deli / Mediterranean",
  caterer: "Caterer / Events", catering: "Caterer / Events", events: "Caterer / Events",
  vegan: "Vegan / Plant-based", vegetarian: "Vegan / Plant-based", "plant based": "Vegan / Plant-based",
  japanese: "Japanese / Sushi", sushi: "Japanese / Sushi", ramen: "Japanese / Sushi",
  indian: "Indian", curry: "Indian",
  chinese: "Chinese", thai: "Thai",
  burger: "Burgers", burgers: "Burgers", "fried chicken": "Fried chicken", kebab: "Kebab",
  cafe: "Cafe / Coffee", coffee: "Cafe / Coffee",
};

export interface CuisineResolution {
  value: string | null; // a known CUISINES name, or null if unmappable
  exact: boolean;
  note?: string;
}

export function resolveCuisine(input: string): CuisineResolution {
  const s = input.trim().toLowerCase();
  if (!s) return { value: null, exact: false };

  // 1) exact known cuisine name
  const exact = CUISINES.find((c) => c.name.toLowerCase() === s);
  if (exact) return { value: exact.name, exact: true };

  // 2) synonym map
  for (const key of Object.keys(CUISINE_SYNONYMS)) {
    if (s === key || s.includes(key)) {
      const value = CUISINE_SYNONYMS[key];
      return { value, exact: false, note: `“${input}” isn’t a category here, so I used the closest match, ${value}` };
    }
  }

  // 3) substring against known names
  const sub = CUISINES.find((c) => c.name.toLowerCase().includes(s) || s.includes(c.name.toLowerCase()));
  if (sub) return { value: sub.name, exact: false, note: `“${input}” → closest category ${sub.name}` };

  // 4) give up — caller should fall back to free-text search
  return { value: null, exact: false };
}

export interface AreaResolution {
  borough?: string;
  text?: string; // when we couldn't map to a borough, search as text instead
  note?: string;
}

export function resolveAreaOrBorough(input: string, boroughs: string[]): AreaResolution {
  const s = input.trim().toLowerCase();
  if (!s) return {};

  // 1) exact borough
  const exact = boroughs.find((b) => b.toLowerCase() === s);
  if (exact) return { borough: exact };

  // 2) neighbourhood → borough (e.g. Soho → Westminster)
  const viaArea = areaToBorough(s);
  if (viaArea && boroughs.some((b) => b.toLowerCase() === viaArea.toLowerCase())) {
    return { borough: viaArea, note: `“${input}” is in ${viaArea}, so I filtered by that borough` };
  }

  // 3) substring borough match
  const sub = boroughs.find((b) => b.toLowerCase().includes(s) || s.includes(b.toLowerCase()));
  if (sub) return { borough: sub, note: `“${input}” → ${sub}` };

  // 4) fall back to text search on the term
  return { text: input, note: `I couldn’t match “${input}” to a borough, so I searched for it as text` };
}

// The single source of truth for whether a venue matches an applied filter.
// Mirrors the Leads view (exact cuisine/borough, case-insensitive; substring
// text; hides excluded by default).
export function matchesFilter(r: Restaurant, f: AppliedFilter): boolean {
  if (r.excluded && !f.includeExcluded) return false;
  if (f.cuisines?.length && !f.cuisines.some((c) => c.toLowerCase() === r.cuisineType.toLowerCase())) return false;
  if (f.boroughs?.length && !f.boroughs.some((b) => b.toLowerCase() === r.borough.toLowerCase())) return false;
  if (f.recommendedOnly && !r.recommended) return false;
  if (f.existingCustomerOnly && !r.existingCustomer) return false;
  if (f.text) {
    const t = f.text.toLowerCase();
    if (!`${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`.toLowerCase().includes(t)) return false;
  }
  return true;
}

export function describeFilter(f: AppliedFilter): string {
  const parts: string[] = [];
  if (f.recommendedOnly) parts.push("recommended");
  parts.push(f.cuisines?.length ? `${f.cuisines.join(" / ")} venues` : "venues");
  if (f.existingCustomerOnly) parts.push("that are customers");
  if (f.boroughs?.length) parts.push(`in ${f.boroughs.join(", ")}`);
  if (f.text) parts.push(`matching “${f.text}”`);
  return parts.join(" ");
}
