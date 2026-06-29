"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Circle, useMap } from "react-leaflet";
// NB: useEffect/useMemo/useState used below for filters + cluster layer.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { DELIVERY_CENTER, DELIVERY_RADIUS_KM } from "@/lib/mock-data";
import { useRestaurants } from "@/lib/store";
import type { PinStatus, Restaurant } from "@/lib/types";

const PIN_COLOURS: Record<PinStatus, string> = {
  high: "#16a34a",
  medium: "#d97706",
  low: "#6b7280",
  existing_customer: "#2563eb",
  new_opening: "#9333ea",
  excluded: "#dc2626",
  closed: "#111827",
};

const PIN_LABELS: Record<PinStatus, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  existing_customer: "Existing LTP customer",
  new_opening: "New opening",
  excluded: "Excluded",
  closed: "Closed / invalid",
};

function pinStatus(r: Restaurant): PinStatus {
  if (r.openingStatus === "closed") return "closed";
  if (r.existingCustomer) return "existing_customer";
  if (r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon") return "new_opening";
  if (r.excluded) return "excluded";
  if (r.leadCategory === "high") return "high";
  if (r.leadCategory === "good" || r.leadCategory === "possible") return "medium";
  return "low";
}

const LONDON_CENTRE: [number, number] = [51.5074, -0.1278];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function popupHtml(r: Restaurant, status: PinStatus): string {
  const contact = r.email ? `<p style="margin:2px 0;color:#64748b">${esc(r.email)}</p>` : "";
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + " " + r.postcode)}`;
  return `
    <div style="min-width:200px">
      <p style="margin:0;font-weight:600;color:#0f172a">${esc(r.name)}</p>
      <p style="margin:2px 0;color:#64748b;font-size:12px">${esc(r.cuisineType)} · ${esc(r.borough)}</p>
      <p style="margin:2px 0;font-size:12px">Score <b>${r.leadScore}</b> · ${PIN_LABELS[status]}</p>
      ${contact}
      <p style="margin:2px 0;font-size:12px;color:#475569">${esc(r.scoreReason)}</p>
      <div style="margin-top:6px;display:flex;gap:6px">
        <a href="/restaurants/${r.id}" style="background:#b91c1c;color:#fff;padding:3px 8px;border-radius:4px;font-size:12px;text-decoration:none">Open profile</a>
        <a href="${maps}" target="_blank" rel="noreferrer" style="background:#f1f5f9;color:#334155;padding:3px 8px;border-radius:4px;font-size:12px;text-decoration:none">Maps</a>
      </div>
    </div>`;
}

// Imperative cluster layer — react-leaflet doesn't wrap markercluster.
function ClusterLayer({ pins }: { pins: { r: Restaurant; status: PinStatus }[] }) {
  const map = useMap();
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = (L as any).markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 55,
      disableClusteringAtZoom: 17,
    });
    for (const { r, status } of pins) {
      const m = L.circleMarker([r.latitude, r.longitude], {
        radius: 7,
        color: "#ffffff",
        weight: 1,
        fillColor: PIN_COLOURS[status],
        fillOpacity: 0.9,
      });
      m.bindPopup(popupHtml(r, status));
      group.addLayer(m);
    }
    map.addLayer(group);
    return () => {
      map.removeLayer(group);
    };
  }, [pins, map]);
  return null;
}

export default function MapView() {
  const { restaurants, loading, focusIds, setFocusIds, viewFilter, setViewFilter } = useRestaurants();
  const [activeStatuses, setActiveStatuses] = useState<Set<PinStatus>>(
    new Set(Object.keys(PIN_COLOURS) as PinStatus[])
  );
  const [showDelivery, setShowDelivery] = useState(true);
  const [query, setQuery] = useState("");
  const [vfCuisines, setVfCuisines] = useState<string[]>([]);
  const [vfBoroughs, setVfBoroughs] = useState<string[]>([]);

  // Init filters from URL (direct/deep links: /map?cuisine=Italian).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("cuisine")) setVfCuisines([p.get("cuisine")!]);
    if (p.get("text")) setQuery(p.get("text")!);
  }, []);

  // Apply the assistant's filter reactively (works even when already on the map).
  useEffect(() => {
    if (!viewFilter) return;
    setVfCuisines(viewFilter.cuisines ?? []);
    setVfBoroughs(viewFilter.boroughs ?? []);
    setQuery(viewFilter.text ?? "");
    setViewFilter(null);
  }, [viewFilter, setViewFilter]);

  function toggle(status: PinStatus) {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const pins = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cz = vfCuisines.map((c) => c.toLowerCase());
    const bz = vfBoroughs.map((b) => b.toLowerCase());
    const focusSet = focusIds ? new Set(focusIds) : null;
    const sourceList = focusSet ? restaurants.filter((r) => focusSet.has(r.id)) : restaurants;
    return sourceList
      .map((r) => ({ r, status: pinStatus(r) }))
      .filter(({ r, status }) => {
        if (!activeStatuses.has(status)) return false;
        if (cz.length && !cz.includes(r.cuisineType.toLowerCase())) return false;
        if (bz.length && !bz.includes(r.borough.toLowerCase())) return false;
        if (q && !`${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [restaurants, activeStatuses, query, vfCuisines, vfBoroughs, focusIds]);

  return (
    <div className="flex h-full gap-4">
      <div className="w-56 shrink-0 space-y-4 overflow-y-auto rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Search</h3>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name, cuisine, borough…"
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
          />
          {(vfCuisines.length > 0 || vfBoroughs.length > 0) && (
            <button onClick={() => { setVfCuisines([]); setVfBoroughs([]); }} className="mt-1 block text-left text-xs text-brand-600 hover:underline">
              {[...vfCuisines, ...vfBoroughs].join(", ")} ✕
            </button>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Pin status</h3>
          <div className="space-y-1.5">
            {(Object.keys(PIN_COLOURS) as PinStatus[]).map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={activeStatuses.has(s)} onChange={() => toggle(s)} />
                <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: PIN_COLOURS[s] }} />
                {PIN_LABELS[s]}
              </label>
            ))}
          </div>
        </div>
        <div className="border-t border-slate-100 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Overlays</h3>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showDelivery} onChange={(e) => setShowDelivery(e.target.checked)} />
            Delivery area
          </label>
        </div>
        {focusIds && (
          <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200">
            {focusIds.length} from your file
            <button onClick={() => setFocusIds(null)} className="ml-1 font-medium text-amber-700 hover:underline">clear ✕</button>
          </div>
        )}
        <p className="text-xs text-slate-400">
          {loading ? "Loading venues…" : `${pins.length.toLocaleString()} venues shown`}
        </p>
      </div>

      <div className="flex-1 overflow-hidden rounded-xl shadow-sm ring-1 ring-slate-200">
        <MapContainer center={LONDON_CENTRE} zoom={12} scrollWheelZoom preferCanvas>
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {showDelivery && (
            <Circle
              center={DELIVERY_CENTER}
              radius={DELIVERY_RADIUS_KM * 1000}
              pathOptions={{ color: "#b91c1c", fillColor: "#b91c1c", fillOpacity: 0.05 }}
            />
          )}
          <ClusterLayer pins={pins} />
        </MapContainer>
      </div>
    </div>
  );
}
