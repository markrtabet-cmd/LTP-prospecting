"use client";

import { useEffect, useMemo, useState } from "react";
import { useRestaurants } from "@/lib/store";
import { CUISINES, PRICE_LABELS, makeRestaurant, scoreRestaurant } from "@/lib/mock-data";
import { displayArea } from "@/lib/locations";
import type { PriceTier, Restaurant } from "@/lib/types";

const BUSINESS_TYPES = ["Restaurant", "Hotel restaurant", "Gastro-pub", "Deli / Food hall", "Caterer", "Farm shop", "Bistro", "Trattoria"];

// Fallback pin placement when there's no GPS fix and no postcode — same
// centroids as the desktop /add page.
const BOROUGH_CENTERS: Record<string, [number, number]> = {
  Westminster: [51.4975, -0.1357], Camden: [51.539, -0.1426], Islington: [51.5362, -0.1031],
  Hackney: [51.545, -0.0553], "Tower Hamlets": [51.5203, -0.0293], Southwark: [51.503, -0.09],
  Lambeth: [51.4607, -0.1163], Wandsworth: [51.457, -0.191], "Kensington and Chelsea": [51.4991, -0.1938],
  "Hammersmith and Fulham": [51.4927, -0.224], "City of London": [51.5155, -0.0922], Greenwich: [51.4826, -0.0077],
};

// Full UK postcode (outward + inward) — only then is a geocode lookup worth firing.
const FULL_POSTCODE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;

const inputCls =
  "block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-slate-400";
const labelCls = "mb-1 block text-xs text-slate-500";
const sectionCls = "text-xs font-semibold uppercase tracking-wider text-slate-400";

type PostcodeGeo = { lat: number; lng: number; district: string | null };

// Full-screen sheet for adding a NEW PROSPECT from the phone. Prospect-only by
// design — customers come from the Power BI sync, so there is no known-venue
// enrichment here; a live duplicate check opens the existing pin instead.
export function AddProspectSheet({
  userLoc,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  userLoc: { lat: number; lng: number } | null;
  onClose: () => void;
  onCreated: (r: Restaurant) => void;
  onOpenExisting: (r: Restaurant) => void;
}) {
  const { restaurants, addRestaurant } = useRestaurants();

  const [name, setName] = useState("");
  const [postcode, setPostcode] = useState("");
  const [address, setAddress] = useState("");
  const [borough, setBorough] = useState("Westminster");
  const [cuisineType, setCuisineType] = useState("Italian");
  const [priceTier, setPriceTier] = useState<PriceTier>(3);
  const [businessType, setBusinessType] = useState("Restaurant");
  const [showContact, setShowContact] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");

  // Pin placement, best first: exact GPS fix ("I'm standing in front of it") >
  // postcode geocode > borough centroid + jitter.
  const [gpsLoc, setGpsLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [pcGeo, setPcGeo] = useState<PostcodeGeo | null>(null);
  const [pcStatus, setPcStatus] = useState<"idle" | "looking" | "found" | "not_found">("idle");

  // Client-side postcode geocode (postcodes.io is keyless — the same service
  // the server-side sync uses). Debounced; also auto-fills the borough from
  // admin_district so the fallback centroid stays sensible.
  useEffect(() => {
    const pc = postcode.trim();
    if (!FULL_POSTCODE.test(pc)) {
      setPcGeo(null);
      setPcStatus("idle");
      return;
    }
    let cancelled = false;
    setPcStatus("looking");
    const t = setTimeout(() => {
      fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`)
        .then((res) => res.json())
        .then((d) => {
          if (cancelled) return;
          const r = d?.result;
          if (d?.status === 200 && typeof r?.latitude === "number" && typeof r?.longitude === "number") {
            setPcGeo({ lat: r.latitude, lng: r.longitude, district: r.admin_district ?? null });
            setPcStatus("found");
            if (r.admin_district) setBorough(r.admin_district);
          } else {
            setPcGeo(null);
            setPcStatus("not_found");
          }
        })
        .catch(() => {
          if (cancelled) return;
          setPcGeo(null);
          setPcStatus("not_found");
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [postcode]);

  // Duplicate guard — same matching as the map search, so a rep who starts
  // typing a venue that's already plotted gets steered to the existing pin
  // instead of creating a twin.
  const dupes = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts: Restaurant[] = [];
    const contains: Restaurant[] = [];
    for (const r of restaurants) {
      if (r.openingStatus === "closed" || !r.latitude || !r.longitude) continue;
      const n = r.name.toLowerCase();
      if (n.startsWith(q)) starts.push(r);
      else if (n.includes(q)) contains.push(r);
      if (starts.length >= 4) break;
    }
    return [...starts, ...contains].slice(0, 4);
  }, [name, restaurants]);

  const preview = scoreRestaurant(cuisineType, priceTier);

  function handleSave() {
    if (!name.trim()) return;
    let lat: number, lng: number;
    if (gpsLoc) {
      lat = gpsLoc.lat;
      lng = gpsLoc.lng;
    } else if (pcGeo) {
      lat = pcGeo.lat;
      lng = pcGeo.lng;
    } else {
      const c = BOROUGH_CENTERS[borough] ?? [51.5095, -0.1265];
      lat = c[0] + (Math.random() - 0.5) * 0.02;
      lng = c[1] + (Math.random() - 0.5) * 0.03;
    }
    const built = makeRestaurant({
      name: name.trim(),
      address: address.trim() || borough,
      postcode: postcode.trim(),
      borough,
      latitude: lat,
      longitude: lng,
      cuisineType,
      businessType,
      priceTier,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      website: website.trim() || undefined,
      existingCustomer: false,
    });
    addRestaurant(built);
    onCreated(built);
  }

  const placementHint = gpsLoc
    ? "Pin drops exactly where you're standing."
    : pcStatus === "found"
      ? `Pin drops at ${postcode.trim().toUpperCase()}${pcGeo?.district ? ` (${pcGeo.district})` : ""}.`
      : pcStatus === "looking"
        ? "Looking up the postcode…"
        : pcStatus === "not_found"
          ? "Postcode not found — the pin drops near the borough centre."
          : "Add a postcode or use your location to place the pin precisely.";

  return (
    <div className="fixed inset-0 z-[1300] flex flex-col bg-white">
      {/* Sticky header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-base font-bold text-slate-900">Add prospect</h2>
        <button onClick={onClose} className="p-2 text-2xl leading-none text-slate-400 active:text-slate-700" aria-label="Close">
          &times;
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <p className="rounded-xl bg-blue-50 px-3 py-2.5 text-xs text-blue-700">
          New <span className="font-semibold">prospects</span> only — customers are synced from Power BI automatically.
        </p>

        {/* Venue */}
        <section className="space-y-3">
          <p className={sectionCls}>Venue</p>
          <div>
            <label className={labelCls}>Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Trattoria Soho"
              autoComplete="off"
              enterKeyHint="next"
              className={inputCls}
            />
          </div>

          {dupes.length > 0 && (
            <div className="overflow-hidden rounded-xl bg-amber-50 ring-1 ring-amber-200/60">
              <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                Already on the map — open instead
              </p>
              {dupes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpenExisting(r)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-amber-100"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{r.name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {r.cuisineType} &middot; {displayArea(r)} &middot; {r.postcode}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-amber-700">Open ›</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Location */}
        <section className="space-y-3">
          <p className={sectionCls}>Location</p>
          <button
            type="button"
            onClick={() => setGpsLoc(gpsLoc ? null : userLoc)}
            disabled={!userLoc && !gpsLoc}
            className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition active:scale-95 disabled:opacity-40 ${
              gpsLoc ? "bg-green-600 text-white" : "bg-slate-100 text-slate-700"
            }`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
            {gpsLoc ? "Using my location — tap to undo" : userLoc ? "Use my location" : "Use my location (waiting for GPS…)"}
          </button>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Postcode</label>
              <input
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                placeholder="W1D 4DP"
                autoComplete="off"
                autoCapitalize="characters"
                enterKeyHint="next"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Borough</label>
              <select value={borough} onChange={(e) => setBorough(e.target.value)} className={inputCls}>
                {Object.keys(BOROUGH_CENTERS).map((b) => (
                  <option key={b}>{b}</option>
                ))}
                {!Object.keys(BOROUGH_CENTERS).includes(borough) && <option>{borough}</option>}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Address</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street address"
              autoComplete="off"
              enterKeyHint="next"
              className={inputCls}
            />
          </div>
          <p className="text-[11px] text-slate-400">{placementHint}</p>
        </section>

        {/* Compatibility */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className={sectionCls}>Compatibility</p>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                preview.recommended ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
              }`}
            >
              Score {preview.leadScore}
              {preview.recommended ? " · Recommended" : ""}
            </span>
          </div>
          <div>
            <label className={labelCls}>Cuisine</label>
            <select value={cuisineType} onChange={(e) => setCuisineType(e.target.value)} className={inputCls}>
              {CUISINES.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Price point</label>
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1">
              {([1, 2, 3, 4] as PriceTier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPriceTier(t)}
                  className={`rounded-lg py-2 text-sm font-semibold transition ${
                    priceTier === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                  }`}
                >
                  {"£".repeat(t)}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">{PRICE_LABELS[priceTier]}</p>
          </div>
          <div>
            <label className={labelCls}>Business type</label>
            <select value={businessType} onChange={(e) => setBusinessType(e.target.value)} className={inputCls}>
              {BUSINESS_TYPES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </div>
        </section>

        {/* Contact details (optional, collapsed by default) */}
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowContact((v) => !v)}
            className="flex w-full items-center justify-between py-1 text-left"
          >
            <span className={sectionCls}>Contact details (optional)</span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-slate-400 transition-transform ${showContact ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showContact && (
            <>
              <div>
                <label className={labelCls}>Phone</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+44 …"
                  type="tel"
                  autoComplete="off"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Email</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="trade@…"
                  type="email"
                  autoComplete="off"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Website</label>
                <input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://…"
                  type="url"
                  autoComplete="off"
                  className={inputCls}
                />
              </div>
            </>
          )}
        </section>
      </div>

      {/* Pinned save bar */}
      <div className="shrink-0 border-t border-slate-100 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className="w-full rounded-xl bg-green-600 py-3.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-40"
        >
          Save prospect
        </button>
      </div>
    </div>
  );
}
