// Airtime: how many hours a flying Roadster would have saved over the drives you actually
// made. Pure functions over a list of drives — no I/O, no clock, no network. The history
// adapter (airtimeHistory.ts) and the demo dataset (data/airtime-demo.json) both produce
// the Drive shape below; scripts/airtime.ts turns the result into web/airtime-data.json.
//
// The two flight constants are HYPOTHETICAL. Tesla has published no cruise speed, range,
// or turnaround figure for the Roadster's flight mode (shown 15 Oct 2026, production
// target 2028). The defaults are a deliberately modest guess so the number reads as a
// floor, not a brag; both are overridable per call and are named as guesses in the UI.

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Drive {
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  from: LatLng;
  to: LatLng;
  driveSeconds: number;
}

export interface AirtimeOptions {
  // Straight-line cruise speed, metres per second. Default 160 km/h.
  cruiseMps?: number;
  // Fixed takeoff + landing overhead per flight, seconds. Default 120 s.
  overheadSeconds?: number;
}

export const DEFAULT_CRUISE_MPS = 160_000 / 3600;
export const DEFAULT_OVERHEAD_SECONDS = 120;

export interface ScoredDrive extends Drive {
  distanceMeters: number;
  flightSeconds: number;
  savedSeconds: number;
}

export interface RouteSummary {
  // "lat,lng>lat,lng" rounded to 3 dp so the same commute collapses to one row.
  key: string;
  from: LatLng;
  to: LatLng;
  drives: number;
  savedSeconds: number;
}

export interface WeekPoint {
  week: string; // ISO week, e.g. "2026-W40"
  savedSeconds: number;
  drives: number;
}

export interface AirtimeSummary {
  totals: { drives: number; km: number; savedHours: number; savedSeconds: number };
  weeks: WeekPoint[];
  topRoutes: RouteSummary[];
  assumptions: { cruiseKph: number; overheadSeconds: number; hypothetical: true };
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export function flightSeconds(distanceMeters: number, opts: AirtimeOptions = {}): number {
  const cruise = opts.cruiseMps ?? DEFAULT_CRUISE_MPS;
  const overhead = opts.overheadSeconds ?? DEFAULT_OVERHEAD_SECONDS;
  return distanceMeters / cruise + overhead;
}

export function scoreDrive(drive: Drive, opts: AirtimeOptions = {}): ScoredDrive {
  const distanceMeters = haversineMeters(drive.from, drive.to);
  const flight = flightSeconds(distanceMeters, opts);
  return {
    ...drive,
    distanceMeters,
    flightSeconds: flight,
    savedSeconds: Math.max(0, drive.driveSeconds - flight),
  };
}

// ISO-8601 week of a date, computed in UTC. Thursday of the same ISO week decides the
// year, which is the one rule people get wrong around New Year.
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function routeKey(d: Drive): string {
  const r = (n: number) => n.toFixed(3);
  return `${r(d.from.lat)},${r(d.from.lng)}>${r(d.to.lat)},${r(d.to.lng)}`;
}

export function summarize(drives: Drive[], opts: AirtimeOptions = {}): AirtimeSummary {
  const scored = drives.map((d) => scoreDrive(d, opts));

  const weeks = new Map<string, WeekPoint>();
  const routes = new Map<string, RouteSummary>();
  let savedSeconds = 0;
  let meters = 0;
  for (const s of scored) {
    savedSeconds += s.savedSeconds;
    meters += s.distanceMeters;

    const week = isoWeek(new Date(s.startedAt));
    const w = weeks.get(week) ?? { week, savedSeconds: 0, drives: 0 };
    w.savedSeconds += s.savedSeconds;
    w.drives += 1;
    weeks.set(week, w);

    const key = routeKey(s);
    const r = routes.get(key) ?? { key, from: s.from, to: s.to, drives: 0, savedSeconds: 0 };
    r.drives += 1;
    r.savedSeconds += s.savedSeconds;
    routes.set(key, r);
  }

  return {
    totals: {
      drives: scored.length,
      km: meters / 1000,
      savedHours: savedSeconds / 3600,
      savedSeconds,
    },
    weeks: [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)),
    topRoutes: [...routes.values()].sort((a, b) => b.savedSeconds - a.savedSeconds).slice(0, 5),
    assumptions: {
      cruiseKph: ((opts.cruiseMps ?? DEFAULT_CRUISE_MPS) * 3600) / 1000,
      overheadSeconds: opts.overheadSeconds ?? DEFAULT_OVERHEAD_SECONDS,
      hypothetical: true,
    },
  };
}

export interface ArcFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { saved_s: number; drive_s: number; flight_s: number; distance_m: number; started_at: string };
}

export interface ArcCollection {
  type: "FeatureCollection";
  features: ArcFeature[];
}

// One two-point LineString per drive (GeoJSON is [lng, lat]). The map bends them into
// arcs client-side; keeping the geometry straight here keeps the file small and honest.
export function toGeoJson(drives: Drive[], opts: AirtimeOptions = {}): ArcCollection {
  return {
    type: "FeatureCollection",
    features: drives.map((d) => {
      const s = scoreDrive(d, opts);
      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [d.from.lng, d.from.lat],
            [d.to.lng, d.to.lat],
          ],
        },
        properties: {
          saved_s: s.savedSeconds,
          drive_s: d.driveSeconds,
          flight_s: s.flightSeconds,
          distance_m: s.distanceMeters,
          started_at: d.startedAt,
        },
      };
    }),
  };
}
