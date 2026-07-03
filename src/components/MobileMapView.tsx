"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { isLondon } from "@/lib/locations";
import { PRICE_LABELS } from "@/lib/mock-data";
import { MigrateLocalData } from "@/components/MigrateLocalData";
import { Assistant } from "@/components/Assistant";
import { MobileCalendarSheet } from "@/components/visits/MobileCalendarSheet";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { signOut } from "@/lib/auth";
import type { ContactNote, ContactOutcome, Meeting, Restaurant } from "@/lib/types";
import type { CustomerInsights, InsightContact } from "@/app/api/powerbi/customer-insights/route";

// Live Power BI data for the customer Contact + Sales panels, fetched fresh
// each time a customer sheet opens (never copied/cached — see the API route).
type InsightsState = {
  status: "idle" | "loading" | "ready" | "error" | "unlinked";
  data: CustomerInsights | null;
  message?: string;
};

const PIN_COLOURS: Record<string, string> = {
  existing_customer: "#2563eb",
  high: "#16a34a",
  new_opening: "#9333ea",
  medium: "#f59e0b",
  low: "#ef4444",
  excluded: "#9ca3af",
};

const OUTCOME_OPTIONS: { value: ContactOutcome; label: string }[] = [
  { value: "visited", label: "Visited" },
  { value: "called", label: "Called" },
  { value: "meeting", label: "Meeting" },
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not interested" },
  { value: "no_answer", label: "No answer" },
  { value: "follow_up", label: "Follow up" },
  { value: "samples_sent", label: "Samples sent" },
  { value: "quote_sent", label: "Quote sent" },
  { value: "emailed", label: "Emailed" },
  { value: "other", label: "Other" },
];

function pinStatus(r: Restaurant): string {
  if (r.openingStatus === "closed") return "closed";
  if (r.existingCustomer) return "existing_customer";
  if (r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") return "new_opening";
  if (r.excluded) return "excluded";
  if (r.leadCategory === "high") return "high";
  if (r.leadCategory === "good" || r.leadCategory === "possible") return "medium";
  return "low";
}

// Smooth red → orange → yellow → green spectrum for cluster averages — matches
// the laptop map so zoomed-out clusters read the same on both.
function scoreToColor(avg: number): string {
  const s = Math.max(41, Math.min(69, avg));
  const hue = Math.round(((s - 41) / 28) * 120); // 41→0°(red), 55→60°(yellow), 69→120°(green)
  return `hsl(${hue}, 80%, 38%)`;
}

// User location — blue dot
function userIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: L.point(28, 28),
    iconAnchor: L.point(14, 14),
    html: `<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px">
      <div style="width:18px;height:18px;border-radius:50%;background:#5a9cf6;border:3px solid #fff;box-shadow:0 0 8px rgba(90,156,246,0.5)"></div>
    </div>`,
  });
}

// ---- Route planning ("sales run" across several venues) --------------------

export interface RoutePoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

// Great-circle distance in metres.
function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathMeters(pts: RoutePoint[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += haversineMeters(pts[i], pts[i + 1]);
  return total;
}

function reverseInPlace(arr: RoutePoint[], i: number, k: number): void {
  while (i < k) {
    const t = arr[i];
    arr[i] = arr[k];
    arr[k] = t;
    i++;
    k--;
  }
}

// Order the stops into the shortest open path that begins at `start` — an
// approximation of the fastest visiting order. Nearest-neighbour gives a decent
// first guess, then 2-opt untangles any crossings. Straight-line distance is
// close to optimal for tightly-packed urban venues; the true road-by-road
// timing is left to Google Maps once the order is fixed. Returns the full path
// INCLUDING `start` at index 0.
function optimizeRoute(start: RoutePoint, stops: RoutePoint[]): RoutePoint[] {
  if (stops.length === 0) return [start];

  const remaining = [...stops];
  const path: RoutePoint[] = [start];
  let current = start;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    current = remaining.splice(bestIdx, 1)[0];
    path.push(current);
  }

  // 2-opt improvement (start node fixed). Capped so large selections stay snappy.
  if (path.length <= 25) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < path.length - 1; i++) {
        for (let k = i + 1; k < path.length; k++) {
          const hasTail = k + 1 < path.length;
          const before =
            haversineMeters(path[i - 1], path[i]) +
            (hasTail ? haversineMeters(path[k], path[k + 1]) : 0);
          const after =
            haversineMeters(path[i - 1], path[k]) +
            (hasTail ? haversineMeters(path[i], path[k + 1]) : 0);
          if (after + 1e-6 < before) {
            reverseInPlace(path, i, k);
            improved = true;
          }
        }
      }
    }
  }

  return path;
}

// Consumer Google Maps directions URL. It does NOT reorder waypoints, so we
// pass our already-optimised order and let Google handle the navigation. Coords
// only use URL-safe characters, so literal `,`/`|` separators (Google's own
// documented format) are fine without extra encoding.
function buildGoogleMapsDirUrl(path: RoutePoint[]): string {
  const coord = (p: RoutePoint) => `${p.lat},${p.lng}`;
  const origin = coord(path[0]);
  const destination = coord(path[path.length - 1]);
  const mids = path.slice(1, -1).map(coord);
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${destination}`;
  if (mids.length) url += `&waypoints=${mids.join("|")}`;
  return url;
}

// Small numbered badge marker drawn on each stop of the planned route.
function routeBadgeIcon(label: string, bg: string): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: L.point(26, 26),
    iconAnchor: L.point(13, 13),
    html: `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;font-weight:700;font-size:13px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35)">${label}</div>`,
  });
}

export function MobileMapView() {
  const { restaurants, updateRestaurant, shared } = useRestaurants();
  const router = useRouter();
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const userMarkerRef = useRef<L.Marker | null>(null);
  const userRingRef = useRef<any>(null);
  const updateRef = useRef(updateRestaurant);
  updateRef.current = updateRestaurant;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  // Author = the signed-in rep (per-user logins landed with the calendar).
  const { me } = useRep();
  const author = me?.name ?? "";
  const [outcome, setOutcome] = useState<ContactOutcome>("visited");
  // Visit calendar sheet + record-meeting flow (opened when the log outcome
  // "Meeting" is picked, or from the calendar itself).
  const [showCalendar, setShowCalendar] = useState(false);
  const [recording, setRecording] = useState<{ venue: Restaurant; meeting?: Meeting } | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [locating, setLocating] = useState(false);
  const [saved, setSaved] = useState(false);
  // Which carousel panel is showing: 0 = activity log, 1 = log contact, 2 = contact info.
  // Customers get two extra Sales slides (3 = monthly sales, 4 = product sales).
  const [activeIndex, setActiveIndex] = useState(1);
  const carouselRef = useRef<HTMLDivElement>(null);
  const [insights, setInsights] = useState<InsightsState>({ status: "idle", data: null });

  // ---- Venue search ----
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- Route planning ----
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [startId, setStartId] = useState<string>("me"); // "me" = current location, else a venue id
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(null);
  const markerByIdRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const lastLocRef = useRef<{ lat: number; lng: number } | null>(null);
  // Latest pin-tap behaviour, read by the Leaflet click handler so markers
  // don't need rebuilding when select mode / selection changes.
  const onPinClickRef = useRef<(r: Restaurant) => void>(() => {});

  // Live version of selected restaurant from the store
  const currentSelected = useMemo(
    () => (selectedId ? restaurants.find((r) => r.id === selectedId) ?? null : null),
    [selectedId, restaurants]
  );
  // Customers get a different sheet: no lead score, no exclude, and Power BI
  // contact + sales panels instead of the prospecting fields.
  const isCustomer = !!currentSelected?.existingCustomer;

  // London pins (excluding closed)
  const londonPins = useMemo(
    () =>
      restaurants.filter(
        (r) => isLondon(r.borough) && r.openingStatus !== "closed" && r.latitude && r.longitude
      ),
    [restaurants]
  );

  // Name/postcode search over the plotted venues — exact-prefix name matches
  // first, then substring/postcode matches.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const qCompact = q.replace(/\s/g, "");
    const starts: Restaurant[] = [];
    const contains: Restaurant[] = [];
    for (const r of londonPins) {
      const name = r.name.toLowerCase();
      if (name.startsWith(q)) starts.push(r);
      else if (name.includes(q) || r.postcode.toLowerCase().replace(/\s/g, "").startsWith(qCompact)) contains.push(r);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }, [query, londonPins]);

  // Create Leaflet map once on mount
  useEffect(() => {
    const div = mapDivRef.current;
    if (!div || mapRef.current) return;

    const map = L.map(div, {
      center: [51.5074, -0.1278],
      zoom: 13,
      zoomControl: false,
    });
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    // Continuous GPS tracking
    let watchId: number | null = null;
    let firstFix = true;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const latlng: L.LatLngExpression = [pos.coords.latitude, pos.coords.longitude];
          const accuracy = pos.coords.accuracy;
          if (userMarkerRef.current) {
            userMarkerRef.current.setLatLng(latlng);
          } else {
            userMarkerRef.current = L.marker(latlng, {
              icon: userIcon(),
              interactive: false,
              zIndexOffset: 10000,
            }).addTo(map);
          }

          // Accuracy ring
          if (userRingRef.current) {
            userRingRef.current.setLatLng(latlng);
            userRingRef.current.setRadius(accuracy);
          } else {
            userRingRef.current = L.circle(latlng, {
              radius: accuracy,
              color: "#5a9cf6",
              fillColor: "#5a9cf6",
              fillOpacity: 0.08,
              weight: 1,
              interactive: false,
            }).addTo(map);
          }

          // Mirror location into state (throttled to ~20 m) so a route can start
          // from "my location" without re-rendering on every GPS tick.
          const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (!lastLocRef.current || haversineMeters(lastLocRef.current, ll) > 20) {
            lastLocRef.current = ll;
            setUserLoc(ll);
          }

          if (firstFix) {
            map.setView(latlng, 15);
            firstFix = false;
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 3000 }
      );
    }

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (userMarkerRef.current) { try { map.removeLayer(userMarkerRef.current); } catch {} userMarkerRef.current = null; }
      if (userRingRef.current) { try { map.removeLayer(userRingRef.current); } catch {} userRingRef.current = null; }
      if (clusterRef.current) {
        try { clusterRef.current.clearLayers(); } catch { /* ignore */ }
      }
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
    };
  }, []);

  // Rebuild cluster markers whenever the pin list changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (clusterRef.current) {
      try { clusterRef.current.clearLayers(); } catch { /* ignore */ }
      try { map.removeLayer(clusterRef.current); } catch { /* ignore */ }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = (L as any).markerClusterGroup({
      chunkedLoading: false,
      maxClusterRadius: 50,
      disableClusteringAtZoom: 16,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      iconCreateFunction: (cluster: any) => {
        const children: any[] = cluster.getAllChildMarkers(); // eslint-disable-line @typescript-eslint/no-explicit-any
        const scores: number[] = children.filter((m) => !m.options.pinIsCustomer).map((m) => m.options.pinScore ?? 50);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;
        const color = scoreToColor(avg);
        const count = cluster.getChildCount();
        const inner = count < 10 ? 28 : count < 50 ? 34 : count < 200 ? 40 : 46;
        const outer = inner + 10; // translucent ring adds 5px each side
        return L.divIcon({
          html: `<div style="position:relative;width:${outer}px;height:${outer}px;display:flex;align-items:center;justify-content:center">
            <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.25"></div>
            <div style="position:relative;width:${inner}px;height:${inner}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.85);color:white;font-weight:700;font-size:${inner <= 28 ? 11 : 12}px;box-shadow:0 1px 4px rgba(0,0,0,0.25)">${count}</div>
          </div>`,
          className: "",
          iconSize: L.point(outer, outer),
          iconAnchor: L.point(outer / 2, outer / 2),
        });
      },
    });

    markerByIdRef.current.clear();
    for (const r of londonPins) {
      const status = pinStatus(r);
      if (status === "closed") continue;
      const color = PIN_COLOURS[status] ?? "#9ca3af";
      const m = L.circleMarker([r.latitude, r.longitude], {
        radius: 10,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 0.9,
        pinScore: r.leadScore,
        pinIsCustomer: status === "existing_customer",
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      m.on("click", () => onPinClickRef.current(r));
      markerByIdRef.current.set(r.id, m);
      group.addLayer(m);
    }

    clusterRef.current = group;
    map.addLayer(group);
  }, [londonPins]);

  // Highlight the markers currently picked for a route.
  useEffect(() => {
    const sel = new Set(selectedIds);
    markerByIdRef.current.forEach((m, id) => {
      if (sel.has(id)) m.setStyle({ radius: 13, weight: 4, color: "#111827" });
      else m.setStyle({ radius: 10, weight: 2, color: "#ffffff" });
    });
  }, [selectedIds, londonPins]);

  // Compute the optimised visiting order for the selected stops.
  const routePlan = useMemo(() => {
    if (selectedIds.length === 0) return null;
    const byId = new Map(restaurants.map((r) => [r.id, r]));
    const stops: RoutePoint[] = selectedIds
      .map((id) => byId.get(id))
      .filter((r): r is Restaurant => !!r && !!r.latitude && !!r.longitude)
      .map((r) => ({ id: r.id, name: r.name, lat: r.latitude, lng: r.longitude }));
    if (stops.length === 0) return null;

    // Resolve the start point: a chosen venue, current location, or (fallback)
    // the first stop when "my location" is picked but there's no GPS fix yet.
    let start: RoutePoint;
    let startIsVenue = false;
    if (startId !== "me") {
      start = stops.find((s) => s.id === startId) ?? stops[0];
      startIsVenue = true;
    } else if (userLoc) {
      start = { id: "me", name: "My location", lat: userLoc.lat, lng: userLoc.lng };
    } else {
      start = stops[0];
      startIsVenue = true;
    }

    const rest = startIsVenue ? stops.filter((s) => s.id !== start.id) : stops;
    const path = optimizeRoute(start, rest);
    return {
      startIsVenue,
      path, // full path incl. start at index 0
      stops: path.slice(1),
      meters: pathMeters(path),
      gmapsUrl: buildGoogleMapsDirUrl(path),
      noLocation: startId === "me" && !userLoc,
    };
  }, [selectedIds, startId, userLoc, restaurants]);

  // Draw / clear the planned route on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (routeLayerRef.current) {
      try { map.removeLayer(routeLayerRef.current); } catch { /* ignore */ }
      routeLayerRef.current = null;
    }
    if (!selectMode || !routePlan) return;

    const layer = L.layerGroup();
    L.polyline(
      routePlan.path.map((p) => [p.lat, p.lng] as [number, number]),
      { color: "#4f46e5", weight: 4, opacity: 0.85, dashArray: "2 8", lineCap: "round" }
    ).addTo(layer);

    routePlan.path.forEach((p, i) => {
      const isStart = i === 0;
      const label = routePlan.startIsVenue ? String(i + 1) : isStart ? "S" : String(i);
      const marker = L.marker([p.lat, p.lng], {
        icon: routeBadgeIcon(label, isStart ? "#2563eb" : "#4f46e5"),
        interactive: p.id !== "me",
        zIndexOffset: 5000,
      });
      // Tapping a numbered badge removes that stop from the route.
      if (p.id !== "me") marker.on("click", () => setSelectedIds((prev) => prev.filter((x) => x !== p.id)));
      marker.addTo(layer);
    });

    layer.addTo(map);
    routeLayerRef.current = layer;
  }, [routePlan, selectMode]);

  // If the venue picked as the start is removed, fall back to "my location".
  useEffect(() => {
    if (startId !== "me" && !selectedIds.includes(startId)) setStartId("me");
  }, [selectedIds, startId]);

  // Auto-clear "Saved!" feedback after 2 s
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  // Fetch live Power BI insights whenever a customer sheet opens.
  useEffect(() => {
    if (!currentSelected?.existingCustomer) {
      setInsights({ status: "idle", data: null });
      return;
    }
    const code = currentSelected.customerAccountCode;
    if (!code) {
      setInsights({ status: "unlinked", data: null });
      return;
    }
    let cancelled = false;
    setInsights({ status: "loading", data: null });
    fetch(`/api/powerbi/customer-insights?code=${encodeURIComponent(code)}`)
      .then((res) => res.json())
      .then((d: CustomerInsights) => {
        if (cancelled) return;
        if (!d.configured || !d.found) setInsights({ status: "unlinked", data: null, message: d.error });
        else if (d.error) setInsights({ status: "error", data: null, message: d.error });
        else setInsights({ status: "ready", data: d });
      })
      .catch(() => {
        if (!cancelled) setInsights({ status: "error", data: null, message: "Network error" });
      });
    return () => {
      cancelled = true;
    };
  }, [currentSelected?.id, currentSelected?.existingCustomer, currentSelected?.customerAccountCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a new pin is selected, start the carousel on the middle (Log) panel.
  useEffect(() => {
    if (!selectedId) return;
    setActiveIndex(1);
    const id = requestAnimationFrame(() => {
      const el = carouselRef.current;
      if (el) el.scrollLeft = el.clientWidth;
    });
    return () => cancelAnimationFrame(id);
  }, [selectedId]);

  // Search-result tap: fly the map straight to the venue. While planning a
  // route it also becomes a stop; otherwise the pin pulses so it's
  // unmistakable among its neighbours.
  function goToResult(r: Restaurant) {
    setQuery("");
    searchInputRef.current?.blur();
    mapRef.current?.flyTo([r.latitude, r.longitude], 17, { duration: 0.9 });
    if (selectMode) {
      setSelectedIds((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
      return;
    }
    const m = markerByIdRef.current.get(r.id);
    if (m) {
      m.setStyle({ radius: 14, weight: 4, color: "#111827" });
      setTimeout(() => {
        if (selectedIdsRef.current.includes(r.id)) return; // now route-selected; keep emphasis
        try { m.setStyle({ radius: 10, weight: 2, color: "#ffffff" }); } catch { /* ignore */ }
      }, 2500);
    }
  }

  function locateMe() {
    const map = mapRef.current;
    if (!map) return;

    // Pan to tracked position if available
    if (userMarkerRef.current) {
      map.setView(userMarkerRef.current.getLatLng(), 16);
      return;
    }
    setLocating(true);
    map.locate({ setView: true, maxZoom: 16 });
    map.once("locationfound", () => setLocating(false));
    map.once("locationerror", () => setLocating(false));
  }

  function onCarouselScroll() {
    const el = carouselRef.current;
    if (!el || !el.clientWidth) return;
    const maxIndex = Math.max(0, el.children.length - 1);
    const idx = Math.min(maxIndex, Math.max(0, Math.round(el.scrollLeft / el.clientWidth)));
    setActiveIndex((prev) => (prev === idx ? prev : idx));
  }

  function scrollToPanel(idx: number) {
    const el = carouselRef.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
    setActiveIndex(idx);
  }

  function saveNote() {
    if (!currentSelected || !noteText.trim()) return;
    const note: ContactNote = {
      id: `note_${Date.now()}`,
      author: author.trim() || "Sales",
      text: noteText.trim(),
      outcome,
      at: new Date(date + "T12:00:00").toISOString(),
    };
    updateRef.current(currentSelected.id, {
      contactLog: [...(currentSelected.contactLog ?? []), note],
    });
    setNoteText("");
    setSaved(true);
  }

  // Picking "Meeting" as the outcome pops up the record-meeting flow (audio +
  // AI summary); it writes the contact note itself on save.
  function handleOutcome(v: ContactOutcome) {
    setOutcome(v);
    if (v === "meeting" && currentSelected) {
      setRecording({ venue: currentSelected });
    }
  }

  function toggleExclude() {
    if (!currentSelected) return;
    updateRef.current(currentSelected.id, { excluded: !currentSelected.excluded });
  }

  async function handleSignOut() {
    await signOut();
    router.replace("/login");
    router.refresh();
  }

  function toggleSelectMode() {
    setSelectMode((on) => {
      const next = !on;
      if (next) setSelectedId(null); // close any open venue sheet
      else { setSelectedIds([]); setStartId("me"); }
      return next;
    });
  }

  // Keep the pin-tap handler current without rebuilding Leaflet markers: in
  // select mode a tap toggles the venue in/out of the route; otherwise it opens
  // the venue sheet as before.
  onPinClickRef.current = (r: Restaurant) => {
    if (selectMode) {
      setSelectedIds((prev) => (prev.includes(r.id) ? prev.filter((x) => x !== r.id) : [...prev, r.id]));
    } else {
      setSelectedId(r.id);
      setNoteText("");
      setSaved(false);
      setDate(new Date().toISOString().slice(0, 10));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Map */}
      <div ref={mapDivRef} className="flex-1" style={{ minHeight: 0 }} />

      {/* Locate button */}
      <button
        onClick={locateMe}
        className="absolute left-4 top-4 z-[1000] flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-lg active:scale-95"
        aria-label="Locate me"
      >
        {locating ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
        )}
      </button>

      {/* Search — dismiss by tapping anywhere outside the results */}
      {query.trim().length >= 2 && (
        <div
          className="absolute inset-0 z-[1000]"
          onClick={() => { setQuery(""); searchInputRef.current?.blur(); }}
        />
      )}
      <div className="absolute left-[72px] right-[68px] top-4 z-[1001]">
        <div className="flex h-12 items-center gap-2 rounded-full bg-white pl-4 pr-1.5 shadow-lg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && searchResults.length) goToResult(searchResults[0]); }}
            enterKeyHint="search"
            placeholder={selectMode ? "Search to add a stop..." : "Search restaurants..."}
            className="h-full w-full min-w-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
          {query && (
            <button
              onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none text-slate-400 active:text-slate-700"
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {query.trim().length >= 2 && (
          <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-2xl bg-white shadow-xl ring-1 ring-slate-200">
            {searchResults.length ? (
              searchResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => goToResult(r)}
                  className="flex w-full items-center gap-2.5 border-b border-slate-100 px-4 py-3 text-left last:border-0 active:bg-slate-50"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: PIN_COLOURS[pinStatus(r)] ?? "#9ca3af" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{r.name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {r.cuisineType} &middot; {r.borough} &middot; {r.postcode}
                    </span>
                  </span>
                  {selectMode && selectedIds.includes(r.id) && (
                    <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700">In route</span>
                  )}
                </button>
              ))
            ) : (
              <p className="px-4 py-3 text-sm text-slate-400">No venues match &ldquo;{query.trim()}&rdquo;</p>
            )}
          </div>
        )}
      </div>

      {/* Plan-route toggle */}
      <button
        onClick={toggleSelectMode}
        className={`absolute left-4 top-[72px] z-[1000] flex h-11 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold shadow-lg active:scale-95 ${
          selectMode ? "bg-brand-500 text-white" : "bg-white text-slate-700"
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="19" r="2" />
          <circle cx="18" cy="5" r="2" />
          <path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h4" />
        </svg>
        {selectMode ? "Cancel" : "Route"}
      </button>

      <Assistant variant="mobile" />

      {/* My calendar — sits under the Lumen button; the map stays the main
          surface and the rep's auto-planned week slides over it. */}
      <button
        onClick={() => setShowCalendar(true)}
        className="absolute left-4 top-[180px] z-[1000] flex h-11 items-center gap-2 rounded-full bg-white px-3 text-sm font-semibold text-slate-700 shadow-lg active:scale-95"
        aria-label="Open my calendar"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        Calendar
      </button>

      {/* Device settings (data sync status, migrate local data, sign out) */}
      <button
        onClick={() => setShowDeviceSettings(true)}
        className="absolute right-4 top-4 z-[1000] flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-lg active:scale-95"
        aria-label="Device settings"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Legend hint */}
      <div className="absolute right-4 top-[72px] z-[1000] flex flex-col gap-1 rounded-xl bg-white/90 px-2.5 py-2 shadow-md text-xs">
        {[
          { color: "#16a34a", label: "High" },
          { color: "#f59e0b", label: "Medium" },
          { color: "#ef4444", label: "Low" },
          { color: "#9333ea", label: "New opening" },
          { color: "#2563eb", label: "Customer" },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-slate-600">{label}</span>
          </div>
        ))}
      </div>

      {/* Bottom sheet */}
      {currentSelected && (
        <div
          className="absolute bottom-0 left-0 right-0 z-[1000] flex flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl"
          style={{ maxHeight: "88vh" }}
        >
          {/* Drag handle */}
          <div className="flex shrink-0 justify-center pb-1 pt-3">
            <div className="h-1 w-10 rounded-full bg-slate-200" />
          </div>

          {/* Restaurant header */}
          <div className="flex shrink-0 items-start justify-between px-5 pb-2 pt-1">
            <div className="flex-1 pr-3">
              <h2 className="text-base font-bold leading-tight text-slate-900">{currentSelected.name}</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                {currentSelected.cuisineType} &middot; {currentSelected.borough}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {isCustomer ? (
                  <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">Customer</span>
                ) : (
                  <>
                    <span className="text-xl font-bold text-slate-900">{currentSelected.leadScore}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
                      {currentSelected.leadCategory}
                    </span>
                    {(currentSelected.openingStatus === "new_this_week" || currentSelected.openingStatus === "opening_soon") && (
                      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">New opening</span>
                    )}
                  </>
                )}
              </div>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              className="-mr-1 -mt-1 p-2 text-2xl leading-none text-slate-400 active:text-slate-700"
              aria-label="Close"
            >
              &times;
            </button>
          </div>

          {/* Quick actions — customers can't be excluded */}
          {(!isCustomer || currentSelected.phone) && (
            <div className="flex shrink-0 gap-2.5 px-5 pb-3">
              {!isCustomer && (
                <button
                  onClick={toggleExclude}
                  className={`flex-1 rounded-xl py-3 text-sm font-semibold transition active:scale-95 ${
                    currentSelected.excluded
                      ? "bg-slate-100 text-slate-700"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  {currentSelected.excluded ? "Un-exclude" : "Exclude"}
                </button>
              )}
              {currentSelected.phone && (
                <a
                  href={`tel:${currentSelected.phone}`}
                  className="flex-1 rounded-xl bg-green-50 py-3 text-center text-sm font-semibold text-green-700 active:scale-95"
                >
                  Call
                </a>
              )}
            </div>
          )}

          {/* Swipe tabs — prospect: Activity · Log · Details / customer: Activity · Log · Contact · Sales */}
          <div className="flex shrink-0 gap-1 px-5 pb-2.5">
            {(isCustomer ? ["Activity", "Log", "Contact", "Sales"] : ["Activity", "Log", "Details"]).map((label, i) => (
              <button
                key={label}
                onClick={() => scrollToPanel(i)}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                  activeIndex === i || (isCustomer && label === "Sales" && activeIndex === 4)
                    ? "bg-brand-500 text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Swipeable carousel */}
          <div
            ref={carouselRef}
            onScroll={onCarouselScroll}
            className="flex h-[44vh] snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {isCustomer ? (
              <>
                {/* Panel 0 — Activity log */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Activity log</p>
                  <ActivityList log={currentSelected.contactLog ?? []} emptyHint="Swipe left to log your first contact." />
                </section>

                {/* Panel 1 — Log contact */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Log a note or meeting</p>
                  <LogForm
                    outcome={outcome}
                    onOutcome={handleOutcome}
                    date={date}
                    onDate={setDate}
                    noteText={noteText}
                    onNoteText={setNoteText}
                    saved={saved}
                    onSave={saveNote}
                  />
                </section>

                {/* Panel 2 — Contact information (live Power BI account details) */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Contact information</p>
                  <CustomerContactPanel r={currentSelected} author={author} state={insights} />
                </section>

                {/* Panel 3 — Sales: last 12 months (live Power BI) */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <div className="mb-3 flex items-baseline justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sales &middot; last 12 months</p>
                    <span className="text-[11px] text-slate-300">products →</span>
                  </div>
                  <MonthlySalesPanel state={insights} />
                </section>

                {/* Panel 4 — Sales: product breakdown, last 3 months (live Power BI) */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <div className="mb-3 flex items-baseline justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Products &middot; last 3 months</p>
                    <span className="text-[11px] text-slate-300">← monthly</span>
                  </div>
                  <ProductSalesPanel state={insights} />
                </section>
              </>
            ) : (
              <>
                {/* Panel 0 — Activity log */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Activity log</p>
                  <ActivityList log={currentSelected.contactLog ?? []} emptyHint="Swipe left to log your first contact." />
                </section>

                {/* Panel 1 — Log contact */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Log contact</p>
                  <LogForm
                    outcome={outcome}
                    onOutcome={handleOutcome}
                    date={date}
                    onDate={setDate}
                    noteText={noteText}
                    onNoteText={setNoteText}
                    saved={saved}
                    onSave={saveNote}
                  />
                </section>

                {/* Panel 2 — Contact information */}
                <section className="h-full w-full shrink-0 snap-center snap-always overflow-y-auto px-5 py-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Contact information</p>
                  <ContactInfo r={currentSelected} />
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {/* Route planner sheet */}
      {selectMode && (
        <div
          className="absolute bottom-0 left-0 right-0 z-[1000] flex flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl"
          style={{ maxHeight: "72vh" }}
        >
          <div className="flex shrink-0 items-start justify-between px-5 pb-2 pt-4">
            <div>
              <h2 className="text-base font-bold leading-tight text-slate-900">Plan a route</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {selectedIds.length === 0
                  ? "Tap venues on the map to add stops."
                  : `${selectedIds.length} stop${selectedIds.length === 1 ? "" : "s"} — fastest order`}
              </p>
            </div>
            <button
              onClick={toggleSelectMode}
              className="-mr-1 -mt-1 p-2 text-2xl leading-none text-slate-400 active:text-slate-700"
              aria-label="Close route planner"
            >
              &times;
            </button>
          </div>

          {selectedIds.length > 0 && (
            <div className="shrink-0 px-5 pb-3">
              <label className="mb-1 block text-xs text-slate-500">Start from</label>
              <select
                value={startId}
                onChange={(e) => setStartId(e.target.value)}
                className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
              >
                <option value="me">My location{userLoc ? "" : " (waiting for GPS…)"}</option>
                {selectedIds.map((id) => {
                  const r = restaurants.find((x) => x.id === id);
                  return r ? <option key={id} value={id}>{r.name}</option> : null;
                })}
              </select>
              {routePlan?.noLocation && (
                <p className="mt-1 text-[11px] text-amber-600">
                  No GPS fix yet — starting from the first stop. Tap the locate button to enable location.
                </p>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            {routePlan ? (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Optimised order</p>
                  <span className="text-xs text-slate-400">≈{(routePlan.meters / 1000).toFixed(1)} km</span>
                </div>
                <ol className="space-y-1.5">
                  {routePlan.path.map((p, i) => (
                    <li key={p.id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                          i === 0 ? "bg-blue-600" : "bg-indigo-600"
                        }`}
                      >
                        {routePlan.startIsVenue ? i + 1 : i === 0 ? "S" : i}
                      </span>
                      <span className="truncate text-sm text-slate-700">{p.name}</span>
                      {i === 0 && <span className="ml-auto shrink-0 text-[11px] text-slate-400">start</span>}
                    </li>
                  ))}
                </ol>
                {routePlan.stops.length > 9 && (
                  <p className="mt-2 text-[11px] text-amber-600">
                    Google Maps may only take the first ~10 stops in a single link.
                  </p>
                )}
              </>
            ) : (
              <div className="rounded-xl bg-slate-50 px-4 py-10 text-center">
                <p className="text-sm text-slate-400">No stops yet.</p>
                <p className="mt-1 text-xs text-slate-400">Zoom in and tap venues to build a route.</p>
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-slate-100 px-5 py-3">
            {selectedIds.length > 0 && (
              <button
                onClick={() => setSelectedIds([])}
                className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600 active:scale-95"
              >
                Clear
              </button>
            )}
            <a
              href={routePlan ? routePlan.gmapsUrl : undefined}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!routePlan}
              className={`flex-1 rounded-xl py-3 text-center text-sm font-semibold transition active:scale-95 ${
                routePlan ? "bg-brand-500 text-white" : "pointer-events-none bg-slate-200 text-slate-400"
              }`}
            >
              Open in Google Maps ↗
            </a>
          </div>
        </div>
      )}

      {/* Device settings sheet — reachable here because the mobile view has no
          nav bar (MobileRedirect keeps phone-width browsers on this screen). */}
      {showDeviceSettings && (
        <div
          className="absolute bottom-0 left-0 right-0 z-[1000] flex flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl"
          style={{ maxHeight: "80vh" }}
        >
          <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
            <h2 className="text-base font-bold text-slate-900">This device</h2>
            <button
              onClick={() => setShowDeviceSettings(false)}
              className="-mr-1 p-2 text-2xl leading-none text-slate-400 active:text-slate-700"
              aria-label="Close"
            >
              &times;
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            <div className="mb-4 flex items-center gap-1.5 text-xs text-slate-400">
              <span className={`inline-block h-2 w-2 rounded-full ${shared ? "bg-green-500" : "bg-amber-400"}`} />
              {shared ? "Shared team data" : "Local only (this browser)"}
            </div>

            <MigrateLocalData />

            {!shared && (
              <p className="mt-3 text-xs text-slate-400">
                Not connected to the shared database yet — data logged on this phone stays on this phone.
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-slate-100 px-5 py-3">
            <button
              onClick={handleSignOut}
              className="w-full rounded-xl bg-slate-100 py-3 text-sm font-semibold text-slate-700 active:scale-95"
            >
              Sign out
            </button>
          </div>
        </div>
      )}

      {/* My calendar (full-screen sheet over the map) */}
      {showCalendar && (
        <MobileCalendarSheet
          onClose={() => setShowCalendar(false)}
          onRecord={(venue, meeting) => setRecording({ venue, meeting })}
          onOpenVenue={(venueId) => {
            setShowCalendar(false);
            const r = restaurants.find((x) => x.id === venueId);
            if (r?.latitude && r?.longitude) {
              mapRef.current?.flyTo([r.latitude, r.longitude], 17, { duration: 0.9 });
              setSelectedId(venueId);
            }
          }}
        />
      )}

      {/* Record meeting (from the log's "Meeting" outcome or the calendar) */}
      {recording && (
        <RecordMeetingSheet
          venue={recording.venue}
          scheduledMeeting={recording.meeting}
          initialNotes={noteText}
          onClose={() => {
            setRecording(null);
            setOutcome("visited");
          }}
          onSaved={() => {
            setNoteText("");
            setSaved(true);
          }}
        />
      )}
    </div>
  );
}

function InfoRow({ label, value, node }: { label: string; value?: string; node?: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{node ?? value}</dd>
    </div>
  );
}

// Add-a-note form. Shared by the prospect "Log" panel and the customer
// "Notes & meetings" panel — outcome + date on one row, then the note.
function LogForm({
  outcome,
  onOutcome,
  date,
  onDate,
  noteText,
  onNoteText,
  saved,
  onSave,
}: {
  outcome: ContactOutcome;
  onOutcome: (v: ContactOutcome) => void;
  date: string;
  onDate: (v: string) => void;
  noteText: string;
  onNoteText: (v: string) => void;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="min-w-0 flex-1 basis-0">
          <label className="mb-1 block text-xs text-slate-500">Outcome</label>
          <select
            value={outcome}
            onChange={(e) => onOutcome(e.target.value as ContactOutcome)}
            className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
          >
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1 basis-0">
          <label className="mb-1 block text-xs text-slate-500">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => onDate(e.target.value)}
            className="block w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-500">Note</label>
        <textarea
          value={noteText}
          onChange={(e) => onNoteText(e.target.value)}
          placeholder="What happened? Who did you speak to?"
          rows={4}
          className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
        />
      </div>

      <button
        onClick={onSave}
        disabled={!noteText.trim()}
        className="w-full rounded-xl bg-brand-500 py-3.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-40"
      >
        {saved ? "Saved!" : "Save note"}
      </button>
    </div>
  );
}

// Read-only history of contact notes / meetings, newest first.
function ActivityList({ log, emptyHint }: { log: ContactNote[]; emptyHint: string }) {
  if (log.length === 0) {
    return (
      <div className="rounded-xl bg-slate-50 px-4 py-10 text-center">
        <p className="text-sm text-slate-400">No activity logged yet.</p>
        <p className="mt-1 text-xs text-slate-400">{emptyHint}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {[...log].reverse().map((note) => (
        <div key={note.id} className="rounded-xl bg-slate-50 px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            {note.outcome ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs capitalize text-slate-600">
                {note.outcome.replace(/_/g, " ")}
              </span>
            ) : (
              <span />
            )}
            <span className="text-xs text-slate-400">
              {new Date(note.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{note.text}</p>
          {note.author && <p className="mt-1 text-xs text-slate-400">— {note.author}</p>}
        </div>
      ))}
    </div>
  );
}

// Contact details. Prospects see the prospecting fields (price, hygiene,
// delivery area); customers see a leaner set sourced from the venue record
// (Power BI account contacts can override these once the sync pulls them).
function ContactInfo({ r, customer = false, author = "" }: { r: Restaurant; customer?: boolean; author?: string }) {
  // For customers, Power BI-synced fields (nightly, once POWERBI_CONTACT_*
  // columns are configured) take priority over the generic FSA-sourced ones.
  const phone = (customer && r.customerContactPhone) || r.phone;
  const email = (customer && r.customerContactEmail) || r.email;

  return (
    <>
      <dl className="space-y-2.5 text-sm">
        {customer && r.customerAccountManager && (
          <InfoRow label="Account manager" value={r.customerAccountManager} />
        )}
        {customer && r.customerContactName && (
          <InfoRow label="Contact" value={r.customerContactName} />
        )}
        <InfoRow label="Address" value={`${r.address}, ${r.postcode}`} />
        <InfoRow
          label="Phone"
          node={phone ? <a className="text-brand-600" href={`tel:${phone}`}>{phone}</a> : "—"}
        />
        <InfoRow
          label="Email"
          node={email ? <a className="break-all text-brand-600" href={`mailto:${email}`}>{email}</a> : "—"}
        />
        <InfoRow
          label="Website"
          node={r.website ? <a className="text-brand-600" href={r.website} target="_blank" rel="noreferrer">Visit site ↗</a> : "—"}
        />
        <InfoRow label="Cuisine" value={r.cuisineType} />
        <InfoRow label="Borough" value={r.borough} />
        {!customer && <InfoRow label="Price point" value={PRICE_LABELS[r.priceTier]} />}
        {!customer && <InfoRow label="Hygiene" value={r.hygieneRating ? `${r.hygieneRating}/5` : "—"} />}
        {!customer && <InfoRow label="Delivery area" value={r.insideDeliveryArea ? "Inside" : "Outside"} />}
      </dl>
      <div className="mt-4 flex gap-2">
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.postcode}`)}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-xl bg-slate-100 py-2.5 text-center text-xs font-semibold text-slate-700 active:scale-95"
        >
          Google Maps ↗
        </a>
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(`${r.name} ${r.borough} restaurant`)}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-xl bg-slate-100 py-2.5 text-center text-xs font-semibold text-slate-700 active:scale-95"
        >
          Search web ↗
        </a>
      </div>
      {customer && (
        <RequestUpdateForm r={r} phone={phone} email={email} author={author} />
      )}
    </>
  );
}

// Quick way to flag wrong/outdated contact details for the Power BI data
// owners to fix. Generates a mailto: email pre-filled with what's currently
// on record plus the salesperson's note — same "open in your own mail app"
// pattern used everywhere else in this app (no automatic sending is wired up).
function RequestUpdateForm({
  r,
  phone,
  email,
  author,
}: {
  r: Restaurant;
  phone?: string;
  email?: string;
  author: string;
}) {
  const [note, setNote] = useState("");
  const to = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL ?? "";

  const subject = `Contact update needed: ${r.name} (${r.postcode})`;
  const body = [
    `Please update the following contact details in Power BI for ${r.name} (${r.postcode}):`,
    "",
    "Current record:",
    `- Account manager: ${r.customerAccountManager || "—"}`,
    `- Contact name: ${r.customerContactName || "—"}`,
    `- Phone: ${phone || "—"}`,
    `- Email: ${email || "—"}`,
    "",
    "Requested change:",
    note.trim(),
    "",
    `Reported by: ${author.trim() || "Sales"} on ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
  ].join("\n");
  const mailto = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <div className="mt-5 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-100">
      <p className="mb-2 text-xs font-semibold text-amber-800">Contact details wrong?</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What needs to change? e.g. phone number is wrong, should be 020 7946 0958"
        rows={2}
        className="w-full resize-none rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-400"
      />
      <a
        href={note.trim() ? mailto : undefined}
        aria-disabled={!note.trim()}
        className={`mt-2 block w-full rounded-lg py-2.5 text-center text-sm font-semibold transition active:scale-95 ${
          note.trim() ? "bg-amber-600 text-white" : "pointer-events-none bg-amber-200 text-amber-400"
        }`}
      >
        Email customer service ↗
      </a>
      {!to && <p className="mt-1.5 text-[11px] text-amber-700">Set NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL to pre-fill the recipient.</p>}
    </div>
  );
}

// ---- Live Power BI customer panels ----------------------------------------

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
}

// Shared loading / not-linked / error display for the live panels.
function InsightsFallback({ state }: { state: InsightsState }) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="flex h-40 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
      </div>
    );
  }
  if (state.status === "unlinked") {
    return (
      <div className="rounded-xl bg-slate-50 px-4 py-10 text-center">
        <p className="text-sm text-slate-500">Not linked to Power BI yet.</p>
        <p className="mt-1 text-xs text-slate-400">
          The nightly sync links matched customers automatically — or the account code wasn&apos;t found in the dataset.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-amber-50 px-4 py-8 text-center">
      <p className="text-sm font-semibold text-amber-800">Couldn&apos;t load live Power BI data</p>
      {state.message && <p className="mt-1 break-words text-xs text-amber-700">{state.message.slice(0, 200)}</p>}
    </div>
  );
}

// Slide 1 — rolling last-12-months sales with calendar YTD, queried live.
function MonthlySalesPanel({ state }: { state: InsightsState }) {
  if (state.status !== "ready" || !state.data) return <InsightsFallback state={state} />;
  const months = state.data.monthly;
  const totalSales = months.reduce((a, m) => a + m.sales, 0);
  const totalKg = months.reduce((a, m) => a + m.kg, 0);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
          <th className="pb-2 font-semibold">Month</th>
          <th className="pb-2 text-right font-semibold">Sales</th>
          <th className="pb-2 text-right font-semibold">KG</th>
          <th className="pb-2 text-right font-semibold">YTD</th>
        </tr>
      </thead>
      <tbody>
        {months.map((m) => (
          <tr key={`${m.year}-${m.month}`} className={`border-t border-slate-100 ${m.sales === 0 ? "text-slate-300" : "text-slate-700"}`}>
            <td className="py-2 font-medium">{MONTH_NAMES[m.month - 1]} {String(m.year).slice(2)}</td>
            <td className="py-2 text-right">{gbp(m.sales)}</td>
            <td className="py-2 text-right">{Math.round(m.kg)}</td>
            <td className="py-2 text-right text-slate-500">{gbp(m.ytd)}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-slate-200 font-semibold text-slate-900">
          <td className="py-2">Total</td>
          <td className="py-2 text-right">{gbp(totalSales)}</td>
          <td className="py-2 text-right">{Math.round(totalKg)}</td>
          <td className="py-2" />
        </tr>
      </tbody>
    </table>
  );
}

// Slide 2 — per-product sales for the rolling last 3 months, queried live.
function ProductSalesPanel({ state }: { state: InsightsState }) {
  if (state.status !== "ready" || !state.data) return <InsightsFallback state={state} />;
  const products = state.data.products;
  if (products.length === 0) {
    return (
      <div className="rounded-xl bg-slate-50 px-4 py-10 text-center">
        <p className="text-sm text-slate-400">No orders in the last 3 months.</p>
      </div>
    );
  }
  const totalSales = products.reduce((a, p) => a + p.sales, 0);
  const totalKg = products.reduce((a, p) => a + p.kg, 0);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
          <th className="pb-2 font-semibold">Product</th>
          <th className="pb-2 text-right font-semibold">KG</th>
          <th className="pb-2 text-right font-semibold">Sales</th>
          <th className="pb-2 pl-2 text-right font-semibold">Last sale</th>
        </tr>
      </thead>
      <tbody>
        {products.map((p) => (
          <tr key={`${p.code}-${p.description}`} className="border-t border-slate-100 text-slate-700">
            <td className="py-2 pr-2">
              <span className="block text-[13px] font-medium leading-snug">{titleCase(p.description)}</span>
              {p.code && <span className="text-[10px] text-slate-400">{p.code}</span>}
            </td>
            <td className="py-2 text-right align-top">{Math.round(p.kg)}</td>
            <td className="py-2 text-right align-top">{gbp(p.sales)}</td>
            <td className="whitespace-nowrap py-2 pl-2 text-right align-top text-xs text-slate-500">{fmtDay(p.lastSale)}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-slate-200 font-semibold text-slate-900">
          <td className="py-2">Total</td>
          <td className="py-2 text-right">{Math.round(totalKg)}</td>
          <td className="py-2 text-right">{gbp(totalSales)}</td>
          <td className="py-2" />
        </tr>
      </tbody>
    </table>
  );
}

function ContactCard({ c }: { c: InsightContact }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">{c.name ? titleCase(c.name) : "Contact"}</p>
        {c.role && <span className="shrink-0 text-xs text-slate-400">{titleCase(c.role)}</span>}
      </div>
      {(c.phone1 || c.phone2) && (
        <p className="mt-1 text-sm">
          {[c.phone1, c.phone2].filter(Boolean).map((p) => (
            <a key={p} href={`tel:${p}`} className="mr-3 text-brand-600">{p}</a>
          ))}
        </p>
      )}
      {c.email && (
        <p className="mt-0.5 text-sm">
          <a href={`mailto:${c.email}`} className="break-all text-brand-600">{c.email.toLowerCase()}</a>
        </p>
      )}
      {c.flags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.flags.map((f) => (
            <span key={f} className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Customer "Contact" tab: live account details + contacts from Power BI, with
// the static venue-record view as fallback while unlinked/unavailable.
function CustomerContactPanel({ r, author, state }: { r: Restaurant; author: string; state: InsightsState }) {
  if (state.status === "loading" || state.status === "idle") return <InsightsFallback state={state} />;
  const a = state.status === "ready" ? state.data?.account : undefined;
  if (!a) {
    return (
      <>
        <p
          className={`mb-3 rounded-lg px-3 py-2 text-xs ${
            state.status === "error" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {state.status === "error"
            ? "Couldn't load live Power BI data — showing basic details."
            : "No Power BI account is linked to this venue yet — showing basic details."}
        </p>
        <ContactInfo r={r} customer author={author} />
      </>
    );
  }

  const phone = a.mainPhone || r.customerContactPhone || r.phone;
  const email = r.customerContactEmail || r.email;
  const statusUp = a.accountStatus.toUpperCase();
  const statusChip = a.accountStatus ? (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        statusUp === "ACTIVE" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
      }`}
    >
      {titleCase(a.accountStatus)}
    </span>
  ) : (
    "—"
  );

  return (
    <>
      <dl className="space-y-2.5 text-sm">
        <InfoRow label="Account manager" value={a.salesRep ? titleCase(a.salesRep) : r.customerAccountManager || "—"} />
        <InfoRow label="Account status" node={statusChip} />
        <InfoRow label="Customer group" value={a.customerGroup || "—"} />
        <InfoRow label="Payment method" value={a.paymentMethod || "—"} />
        <InfoRow label="Terms" value={a.terms || "—"} />
        <InfoRow label="Price list" value={a.priceList || "—"} />
        <InfoRow label="Min order" value={a.minOrder != null ? gbp(a.minOrder) : "—"} />
        <InfoRow label="Avg order value" value={a.adv != null ? gbp(a.adv) : "—"} />
        <InfoRow
          label="Main telephone"
          node={phone ? <a className="text-brand-600" href={`tel:${phone}`}>{phone}</a> : "—"}
        />
        <InfoRow label="Last route" value={a.lastRoute || "—"} />
        <InfoRow label="Last sale" value={fmtDay(a.lastSale)} />
        <InfoRow label="Address" value={`${r.address}, ${r.postcode}`} />
      </dl>

      {state.data && state.data.contacts.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Contacts</p>
          <div className="space-y-2">
            {state.data.contacts.map((c, i) => (
              <ContactCard key={i} c={c} />
            ))}
          </div>
        </div>
      )}

      <RequestUpdateForm r={r} phone={phone} email={email} author={author} />
    </>
  );
}
