// Bridges freetessie's history store (src/freetessie/history.ts) into Airtime's Drive
// shape. The drives table does record both endpoints — start_lat/start_lon are taken from
// the snapshot that opened the row and end_lat/end_lon track the latest snapshot — so no
// guessing is needed. Rows are skipped, not faked, when a coordinate is null (the car
// reported no position) or the drive is still open (ended_at IS NULL).
//
// Caveat on fidelity: history.ts only sees the car when something reads it (a text, the
// poller, or Fleet Telemetry if wired). A drive observed once at the start and once at the
// end is exact on endpoints but its duration is bounded by snapshot timing; with sparse
// polling, expect drives to be slightly under-counted, never over-counted.

import type { DriveRow } from "../freetessie/contracts.ts";
import type { Drive } from "./airtime.ts";

export interface DriveSource {
  drives(fromMs?: number, toMs?: number): DriveRow[];
}

export function driveRowToDrive(row: DriveRow): Drive | null {
  if (
    row.endedAt === null ||
    row.startLat === null ||
    row.startLon === null ||
    row.endLat === null ||
    row.endLon === null
  ) {
    return null;
  }
  const driveSeconds = (row.endedAt - row.startedAt) / 1000;
  if (driveSeconds <= 0) return null;
  return {
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: new Date(row.endedAt).toISOString(),
    from: { lat: row.startLat, lng: row.startLon },
    to: { lat: row.endLat, lng: row.endLon },
    driveSeconds,
  };
}

export function drivesFromHistory(source: DriveSource, fromMs?: number, toMs?: number): Drive[] {
  return source
    .drives(fromMs, toMs)
    .map(driveRowToDrive)
    .filter((d): d is Drive => d !== null);
}
