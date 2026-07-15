// Delivery days by London postcode district (outward code), from LTP's delivery
// spreadsheet. Only the postcode → days mapping is used (driver/rep/price cols
// dropped). Typos in the source normalised (e.g. THUE→TUE, dash-lists → commas).

import { getRegion } from "@/lib/locations";

const DELIVERY_DAYS: Record<string, string> = {
  // E
  E1: "MON-FRI", E2: "MON-SAT", E3: "MON, WED, FRI", E4: "MON, WED, FRI", E5: "MON, WED, FRI",
  E6: "MON, WED, FRI", E7: "MON, WED, FRI", E8: "MON, WED, FRI", E9: "MON, WED, FRI", E10: "MON, WED, FRI",
  E11: "MON, WED, FRI", E12: "MON, WED, FRI", E13: "MON, WED, FRI", E14: "MON-SAT", E15: "MON, WED, FRI",
  E16: "MON-FRI", E17: "MON, WED, FRI", E18: "MON, WED, FRI", E19: "MON, WED, FRI", E20: "MON, WED, FRI",
  // EC / WC
  EC1: "MON, WED, FRI", EC2: "MON, WED, FRI", EC3: "MON, WED, FRI", EC4: "MON, WED, FRI",
  WC1: "MON-SAT", WC2: "MON-SAT",
  // SW
  SW1Y: "MON-SAT", SW1A: "MON-SAT", SW1: "MON-SAT", SW2: "TUE, THU", SW3: "MON-SAT", SW4: "TUE, THU, SAT",
  SW5: "MON-SAT", SW6: "MON-SAT", SW7: "MON-SAT", SW8: "MON-SAT", SW9: "TUE, THU", SW10: "MON-SAT",
  SW11: "MON-SAT", SW12: "MON, WED, FRI", SW13: "TUE, THU, SAT", SW14: "TUE, THU, SAT", SW15: "MON, WED, FRI",
  SW16: "MON, WED, FRI", SW17: "MON, WED, FRI", SW18: "MON, WED, FRI", SW19: "MON, WED, FRI",
  // N
  N1: "MON-SAT", N2: "TUE, THU", N3: "TUE, THU", N4: "MON-FRI", N5: "MON-FRI", N6: "MON-FRI", N7: "MON-FRI",
  N8: "MON-FRI", N9: "TUE, THU", N10: "MON, WED, FRI", N11: "TUE, THU", N12: "TUE, THU", N13: "TUE, THU",
  N14: "TUE, THU", N15: "MON-FRI", N16: "MON-FRI", N17: "MON, WED, FRI", N18: "TUE, THU", N19: "MON-FRI",
  N20: "TUE, THU", N21: "TUE, THU", N22: "MON, WED, FRI",
  // NW
  NW1: "MON-SAT", NW2: "MON, WED, FRI", NW3: "MON, WED, FRI", NW4: "MON, WED, FRI", NW5: "MON, WED, FRI",
  NW6: "MON, WED, FRI", NW7: "MON, WED, FRI", NW8: "MON-SAT", NW9: "MON, WED, FRI", NW10: "MON-SAT", NW11: "MON, WED, FRI",
  // W
  W1: "MON-SAT", W2: "MON, TUE-FRI, SAT", W3: "MON, WED, FRI", W4: "TUE, THU, SAT", W5: "MON, WED, FRI",
  W6: "MON-SAT", W7: "MON, WED, FRI", W8: "MON-SAT", W9: "MON, WED, FRI", W10: "TUE, THU", W11: "MON-SAT",
  W12: "MON-FRI", W13: "MON, WED, FRI", W14: "MON-SAT",
  // SE
  SE1: "MON-SAT", SE2: "THU", SE3: "TUE, THU", SE4: "TUE, THU", SE5: "TUE, THU", SE6: "THU", SE7: "TUE, THU",
  SE8: "TUE, THU", SE9: "THU", SE10: "TUE, THU", SE11: "TUE, THU", SE12: "THU", SE13: "TUE, THU", SE14: "TUE, THU",
  SE15: "TUE, THU", SE16: "TUE, THU", SE17: "TUE, THU", SE18: "THU", SE19: "TUE", SE20: "TUE", SE21: "TUE, THU",
  SE22: "TUE, THU", SE23: "TUE, THU", SE24: "TUE, THU", SE25: "TUE", SE26: "TUE", SE27: "TUE, THU", SE28: "THU",
  // TW
  TW1: "TUE, THU, SAT", TW2: "TUE, THU, SAT", TW3: "TUE, THU", TW4: "TUE, THU", TW5: "TUE, THU", TW6: "TUE, THU",
  TW7: "TUE, THU", TW8: "TUE, THU, SAT", TW9: "TUE, THU, SAT", TW10: "TUE, THU, SAT", TW11: "TUE, THU, SAT",
  TW12: "TUE, THU, SAT", TW13: "TUE, THU", TW14: "TUE, THU", TW15: "TUE, THU", TW16: "TUE, THU", TW17: "TUE, THU",
  TW18: "TUE, THU", TW19: "TUE, THU", TW20: "TUE-THU",
  // HA
  HA0: "TUE-THU", HA1: "TUE-THU", HA2: "TUE-THU", HA3: "TUE-THU", HA4: "TUE-THU", HA5: "TUE-THU",
  HA6: "TUE-THU", HA7: "TUE-THU", HA8: "TUE-THU", HA9: "TUE-THU",
  // UB
  UB1: "TUE, THU", UB2: "TUE, THU", UB3: "TUE, THU", UB4: "TUE, THU", UB5: "TUE, THU", UB6: "TUE, THU",
  UB7: "TUE, THU", UB8: "TUE, THU", UB9: "TUE, THU", UB10: "TUE, THU", UB11: "TUE, THU",
};

/** The outward code (district) of a UK postcode, e.g. "SE1 3XX" → "SE1". */
export function outwardCode(postcode: string | undefined | null): string {
  if (!postcode) return "";
  const pc = postcode.toUpperCase().replace(/\s+/g, "");
  if (!pc) return "";
  // Inward code is always the last 3 chars (digit + 2 letters).
  return pc.length > 3 ? pc.slice(0, -3) : pc;
}

/** Delivery days for a venue's postcode, or null if its district isn't listed. */
export function deliveryDaysForPostcode(postcode: string | undefined | null): string | null {
  const oc = outwardCode(postcode);
  if (!oc) return null;
  // Exact outward code first, so hand-added sub-districts (e.g. SW1A, SW1Y)
  // beat their numeric parent.
  if (DELIVERY_DAYS[oc]) return DELIVERY_DAYS[oc];
  // Central-London postcodes carry a lettered sub-district (W1D, EC2R, WC2N,
  // SW1E, N1C…). The table only lists the numeric parent (W1, EC2, WC2, SW1,
  // N1), so strip a trailing letter and retry — otherwise the whole West End /
  // City core silently loses the row.
  const district = oc.match(/^([A-Z]{1,2}\d{1,2})[A-Z]$/)?.[1];
  return (district && DELIVERY_DAYS[district]) || null;
}

/**
 * Delivery days for a venue. Customers located OUTSIDE London deliver Tuesday to
 * Friday as a fixed regional schedule (the London postcode table only covers the
 * London/Home-Counties delivery grid). London customers and all prospects keep
 * the per-district table days.
 *
 * We detect "outside London" with getRegion(borough, postcode) rather than raw
 * isLondon(borough): auto-placed customers can carry the literal borough "London"
 * (a geocode fallback, not a real borough) for which isLondon returns false —
 * getRegion falls back to the postcode area and correctly keeps them on the
 * London schedule.
 */
export function deliveryDaysForVenue(v: {
  postcode?: string | null;
  borough?: string | null;
  existingCustomer?: boolean;
}): string | null {
  if (v.existingCustomer && getRegion(v.borough ?? "", v.postcode ?? "") !== "London") {
    return "TUE-FRI";
  }
  return deliveryDaysForPostcode(v.postcode);
}
