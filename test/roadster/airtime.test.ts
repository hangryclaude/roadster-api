import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DEFAULT_CRUISE_MPS,
  DEFAULT_OVERHEAD_SECONDS,
  haversineMeters,
  isoWeek,
  scoreDrive,
  summarize,
  toGeoJson,
  type Drive,
} from "../../src/roadster/airtime.ts";
import { driveRowToDrive } from "../../src/roadster/airtimeHistory.ts";

const LAX = { lat: 33.9416, lng: -118.4085 };
const SFO = { lat: 37.6213, lng: -122.379 };

test("haversine: LAX to SFO is about 543 km, and a point to itself is 0", () => {
  const m = haversineMeters(LAX, SFO);
  assert.ok(Math.abs(m - 543_000) < 2_000, `got ${m}`);
  assert.equal(haversineMeters(LAX, LAX), 0);
  assert.ok(Math.abs(haversineMeters(LAX, SFO) - haversineMeters(SFO, LAX)) < 1e-6);
});

test("isoWeek handles the year boundary the ISO way", () => {
  assert.equal(isoWeek(new Date("2026-10-15T12:00:00Z")), "2026-W42");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(isoWeek(new Date("2026-01-01T12:00:00Z")), "2026-W01");
});

// Three drives with hand-computable outcomes:
//  A: LAX -> SFO, 6 h on the road. flight = 543 km / 160 km/h + 120 s ≈ 12,218 s + 120 s.
//  B: LAX -> LAX (zero distance), 10 min. flight = overhead only -> saved = 600 - 120 = 480 s.
//  C: LAX -> SFO, 1 h on the road (faster than flying) -> saved clamps to 0.
const A: Drive = { startedAt: "2026-10-12T15:00:00Z", endedAt: "2026-10-12T21:00:00Z", from: LAX, to: SFO, driveSeconds: 6 * 3600 };
const B: Drive = { startedAt: "2026-10-13T15:00:00Z", endedAt: "2026-10-13T15:10:00Z", from: LAX, to: LAX, driveSeconds: 600 };
const C: Drive = { startedAt: "2026-10-20T15:00:00Z", endedAt: "2026-10-20T16:00:00Z", from: LAX, to: SFO, driveSeconds: 3600 };

test("scoreDrive: flight time is distance/cruise + overhead and saved time never goes negative", () => {
  const a = scoreDrive(A);
  const expectedFlight = a.distanceMeters / DEFAULT_CRUISE_MPS + DEFAULT_OVERHEAD_SECONDS;
  assert.ok(Math.abs(a.flightSeconds - expectedFlight) < 1e-9);
  assert.ok(Math.abs(a.savedSeconds - (6 * 3600 - expectedFlight)) < 1e-9);

  assert.equal(scoreDrive(B).savedSeconds, 600 - DEFAULT_OVERHEAD_SECONDS);
  assert.equal(scoreDrive(C).savedSeconds, 0);
});

test("summarize: totals, weekly buckets, top routes, and the assumptions are labelled hypothetical", () => {
  const s = summarize([A, B, C]);
  const expectedSaved = scoreDrive(A).savedSeconds + 480 + 0;
  assert.equal(s.totals.drives, 3);
  assert.ok(Math.abs(s.totals.savedSeconds - expectedSaved) < 1e-9);
  assert.ok(Math.abs(s.totals.savedHours - expectedSaved / 3600) < 1e-9);
  assert.ok(Math.abs(s.totals.km - (2 * haversineMeters(LAX, SFO)) / 1000) < 1e-9);

  assert.deepEqual(s.weeks.map((w) => w.week), ["2026-W42", "2026-W43"]);
  assert.equal(s.weeks[0].drives, 2);
  assert.equal(s.weeks[1].drives, 1);

  // A and C share a route key (same endpoints) so they collapse into one row that leads.
  assert.equal(s.topRoutes.length, 2);
  assert.equal(s.topRoutes[0].drives, 2);
  assert.ok(Math.abs(s.topRoutes[0].savedSeconds - scoreDrive(A).savedSeconds) < 1e-9);

  assert.equal(s.assumptions.hypothetical, true);
  assert.equal(s.assumptions.cruiseKph, 160);
  assert.equal(s.assumptions.overheadSeconds, 120);
});

test("summarize honours custom cruise/overhead", () => {
  const s = summarize([B], { cruiseMps: 50, overheadSeconds: 60 });
  assert.equal(s.totals.savedSeconds, 540);
  assert.equal(s.assumptions.cruiseKph, 180);
});

test("toGeoJson emits one [lng,lat] LineString per drive with the saved seconds on it", () => {
  const g = toGeoJson([A, B]);
  assert.equal(g.type, "FeatureCollection");
  assert.equal(g.features.length, 2);
  const f = g.features[0];
  assert.equal(f.type, "Feature");
  assert.equal(f.geometry.type, "LineString");
  assert.deepEqual(f.geometry.coordinates, [
    [LAX.lng, LAX.lat],
    [SFO.lng, SFO.lat],
  ]);
  assert.ok(Math.abs(f.properties.saved_s - scoreDrive(A).savedSeconds) < 1e-9);
  assert.equal(f.properties.drive_s, A.driveSeconds);
  assert.equal(f.properties.started_at, A.startedAt);
});

test("demo dataset loads, has ~60 drives over 8 ISO weeks, and produces a positive total", () => {
  const { drives } = JSON.parse(fs.readFileSync("data/airtime-demo.json", "utf8")) as { drives: Drive[] };
  assert.ok(drives.length >= 55 && drives.length <= 65, `got ${drives.length}`);
  const s = summarize(drives);
  assert.equal(s.weeks.length, 8);
  assert.ok(s.totals.savedHours > 10);
  for (const d of drives) assert.ok(d.driveSeconds >= 35 * 60 && d.driveSeconds <= 95 * 60);
});

test("driveRowToDrive maps a closed history row and skips open or position-less ones", () => {
  const base = {
    id: 1, startedAt: Date.UTC(2026, 9, 1, 15), endedAt: Date.UTC(2026, 9, 1, 16),
    startOdometer: 0, endOdometer: 40, startBattery: 80, endBattery: 70,
    startLat: LAX.lat, startLon: LAX.lng, endLat: SFO.lat, endLon: SFO.lng,
  };
  const d = driveRowToDrive(base);
  assert.ok(d);
  assert.equal(d.driveSeconds, 3600);
  assert.deepEqual(d.from, LAX);
  assert.deepEqual(d.to, SFO);
  assert.equal(driveRowToDrive({ ...base, endedAt: null }), null);
  assert.equal(driveRowToDrive({ ...base, endLat: null }), null);
});
