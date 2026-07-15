// Ice-cream / gelato shops are not fresh-pasta prospects, so they're excluded
// from leads and the map. They're hard to catch by cuisineType: Google Places
// folds `ice_cream_shop` / `dessert_shop` into "Cafe / Coffee" and the raw type
// isn't persisted, while a name-classified gelateria can land as "Italian" or
// "Other / Unknown". So the reliable signal is the venue NAME (plus the explicit
// "Ice cream / Gelato" cuisine once the FSA pull starts stamping it).

// No trailing word-boundary: "gelat" must match "gelato" / "gelateria" / "gelati"
// (a trailing \b would fail there, since the next char is still a word char).
const ICE_CREAM_NAME_RE = /\b(gelat|ice[-\s]?cream|sorbet|soft[-\s]?serve|creamery|scoop shop|frozen yog|froyo)/i;

/** True for an ice-cream / gelato venue, by name or an explicit ice-cream cuisine. */
export function isIceCreamShop(r: { name?: string; cuisineType?: string }): boolean {
  const cuisine = (r.cuisineType ?? "").toLowerCase();
  if (cuisine.includes("ice cream") || cuisine.includes("gelato")) return true;
  return ICE_CREAM_NAME_RE.test(r.name ?? "");
}

// Kebab / doner / shawarma shops are never fresh-pasta prospects. As with
// ice-cream, the venue NAME is the reliable signal (a shop mislabelled "Turkish"
// / "Middle Eastern" / "Other" still reads "kebab" in its name). Kept tight to
// unambiguous doner-kebab words so Greek souvlaki/gyros venues and generic
// "grill" steakhouses (valid leads) are NOT swept in. Leading \b only, so
// "kebab" matches inside "German Doner Kebab" but not mid-word noise.
const KEBAB_NAME_RE = /\b(kebab|kebap|kebob|shawarma|shawurma|shawerma|doner|donner|döner|iskender|lahmacun)/i;

/** True for a kebab / doner / shawarma venue, by name or an explicit Kebab cuisine. */
export function isKebabShop(r: { name?: string; cuisineType?: string }): boolean {
  const cuisine = (r.cuisineType ?? "").toLowerCase();
  if (cuisine === "kebab") return true;
  return KEBAB_NAME_RE.test(r.name ?? "");
}

/** Venues that can never be a fresh-pasta prospect and must always be excluded
 * from leads and the map: ice-cream / gelato shops and kebab / doner shops. */
export function isExcludedVenue(r: { name?: string; cuisineType?: string }): boolean {
  return isIceCreamShop(r) || isKebabShop(r);
}
