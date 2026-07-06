// Optimised multi-stop route planning ("sales run" across several venues).
// Shared between the map's manual route planner (pick pins, plan a route) and
// the calendar's per-day route button (auto-route today's booked visits).

export interface RoutePoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

// Great-circle distance in metres.
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathMeters(pts: RoutePoint[]): number {
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
export function optimizeRoute(start: RoutePoint, stops: RoutePoint[]): RoutePoint[] {
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
            haversineMeters(path[i - 1], path[i]) + (hasTail ? haversineMeters(path[k], path[k + 1]) : 0);
          const after =
            haversineMeters(path[i - 1], path[k]) + (hasTail ? haversineMeters(path[i], path[k + 1]) : 0);
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
export function buildGoogleMapsDirUrl(path: RoutePoint[]): string {
  const coord = (p: RoutePoint) => `${p.lat},${p.lng}`;
  const origin = coord(path[0]);
  const destination = coord(path[path.length - 1]);
  const mids = path.slice(1, -1).map(coord);
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${destination}`;
  if (mids.length) url += `&waypoints=${mids.join("|")}`;
  return url;
}
