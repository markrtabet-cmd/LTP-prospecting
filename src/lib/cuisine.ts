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
