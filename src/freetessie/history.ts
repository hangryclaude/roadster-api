// History recorder: turns a stream of vehicle_data snapshots into drives/charges/idles
// session rows. Pure state machine over whatever the caller feeds observe() — no polling,
// no fetch, no timers (see FREETESSIE-BRIEF.md §5 "no setInterval, ever"). The caller
// (telemetry ingester, or a live-read route) decides when a snapshot happens.
//
// Session detection: each snapshot maps to exactly one of driving/charging/idle (priority
// order below), and at most one of the three tables ever has an open row (ended_at IS NULL)
// at a time, matching that mutual exclusivity. A row is opened on transition in; on the
// transition OUT, the closing snapshot's own data becomes the row's final end values before
// the next row opens — the boundary is a single point, not a gap between two snapshots.
// While a row stays open across same-mode snapshots, its end fields track the latest
// snapshot so a crash mid-session still leaves a usable (if not yet "closed") row.

import type { DatabaseSync } from "node:sqlite";
import type {
  ChargeRow,
  DriveRow,
  FleetVehicleData,
  HistoryRecorder,
  IdleRow,
} from "./contracts.ts";

type Mode = "driving" | "charging" | "idle";

// We only see the car when someone asks or telemetry pushes — a snapshot more than this
// long after the previous one means we have no idea what happened in between, so the
// in-flight session is closed at the LAST known-good time rather than stretched across
// the blackout.
const GAP_MS = 30 * 60 * 1000;

function modeOf(data: FleetVehicleData): Mode {
  const shiftState = data.drive_state?.shift_state ?? "";
  const speed = data.drive_state?.speed;
  const isDriving =
    shiftState === "D" || shiftState === "R" || shiftState === "N" ||
    (typeof speed === "number" && speed > 0);
  if (isDriving) return "driving";
  if (data.charge_state?.charging_state === "Charging") return "charging";
  return "idle";
}

interface OpenSession {
  mode: Mode;
  id: number;
}

interface DriveRowData {
  id: number;
  started_at: number;
  ended_at: number | null;
  start_odometer: number;
  end_odometer: number | null;
  start_battery: number;
  end_battery: number | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
}

interface ChargeRowData {
  id: number;
  started_at: number;
  ended_at: number | null;
  start_battery: number;
  end_battery: number | null;
  energy_added_kwh: number | null;
  lat: number | null;
  lon: number | null;
}

interface IdleRowData {
  id: number;
  started_at: number;
  ended_at: number | null;
  start_battery: number;
  end_battery: number | null;
}

function toDriveRow(r: DriveRowData): DriveRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    startOdometer: r.start_odometer,
    endOdometer: r.end_odometer,
    startBattery: r.start_battery,
    endBattery: r.end_battery,
    startLat: r.start_lat,
    startLon: r.start_lon,
    endLat: r.end_lat,
    endLon: r.end_lon,
  };
}

function toChargeRow(r: ChargeRowData): ChargeRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    startBattery: r.start_battery,
    endBattery: r.end_battery,
    energyAddedKwh: r.energy_added_kwh,
    lat: r.lat,
    lon: r.lon,
  };
}

function toIdleRow(r: IdleRowData): IdleRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    startBattery: r.start_battery,
    endBattery: r.end_battery,
  };
}

// Tessie's documented GET /{vin}/drives, /charges, /idles field names
// (https://developer.tessie.com/reference) are snake_case and disjoint from DriveRow/
// ChargeRow/IdleRow's camelCase (contracts.ts, locked — HistoryRecorder must keep returning
// those types). A generic Tessie client parsing the HTTP response needs the wire shape
// below, not the internal row shape serialized as-is. Fields Tessie documents but this
// project has no data for (starting_location/ending_location need reverse geocoding, which
// history.ts never does; average_speed isn't tracked) are omitted rather than faked —
// matching toTessieBattery/toTessieLocation's "only what Fleet API actually gives us"
// convention in tessieShape.ts.
//
// NOTE for whoever wires this in: server.ts's GET /:vin/drives /charges /idles route
// handlers (lines ~269-280) currently do `c.json(deps.history.drives(...))` — returning the
// camelCase DriveRow[] directly. They need to map through these before c.json() instead.
// Not done here: server.ts isn't owned by this fix pass.
export interface TessieDriveWire {
  id: number;
  started_at: number;
  ended_at: number | null;
  starting_odometer: number;
  ending_odometer: number | null;
  odometer_distance: number | null;
  starting_battery: number;
  ending_battery: number | null;
  starting_latitude: number | null;
  starting_longitude: number | null;
  ending_latitude: number | null;
  ending_longitude: number | null;
}

export interface TessieChargeWire {
  id: number;
  started_at: number;
  ended_at: number | null;
  starting_battery: number;
  ending_battery: number | null;
  energy_added: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface TessieIdleWire {
  id: number;
  started_at: number;
  ended_at: number | null;
  starting_battery: number;
  ending_battery: number | null;
}

export function toTessieDriveWire(r: DriveRow): TessieDriveWire {
  return {
    id: r.id,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    starting_odometer: r.startOdometer,
    ending_odometer: r.endOdometer,
    odometer_distance: r.endOdometer === null ? null : r.endOdometer - r.startOdometer,
    starting_battery: r.startBattery,
    ending_battery: r.endBattery,
    starting_latitude: r.startLat,
    starting_longitude: r.startLon,
    ending_latitude: r.endLat,
    ending_longitude: r.endLon,
  };
}

export function toTessieChargeWire(r: ChargeRow): TessieChargeWire {
  return {
    id: r.id,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    starting_battery: r.startBattery,
    ending_battery: r.endBattery,
    energy_added: r.energyAddedKwh,
    latitude: r.lat,
    longitude: r.lon,
  };
}

export function toTessieIdleWire(r: IdleRow): TessieIdleWire {
  return {
    id: r.id,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    starting_battery: r.startBattery,
    ending_battery: r.endBattery,
  };
}

// odometer/battery default to 0 (not null) when a snapshot omits them, matching the
// "absent telemetry is 0, not a crash" convention tessieAdapter.ts's normalizeState uses.
function odometerOf(data: FleetVehicleData): number {
  return data.vehicle_state?.odometer ?? 0;
}
function batteryOf(data: FleetVehicleData): number {
  return data.charge_state?.battery_level ?? 0;
}
function latOf(data: FleetVehicleData): number | null {
  return data.drive_state?.latitude ?? null;
}
function lonOf(data: FleetVehicleData): number | null {
  return data.drive_state?.longitude ?? null;
}
function energyAddedOf(data: FleetVehicleData): number | null {
  return data.charge_state?.charge_energy_added ?? null;
}

export function createHistoryRecorder(db: DatabaseSync): HistoryRecorder {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      start_odometer REAL NOT NULL,
      end_odometer REAL,
      start_battery REAL NOT NULL,
      end_battery REAL,
      start_lat REAL,
      start_lon REAL,
      end_lat REAL,
      end_lon REAL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      start_battery REAL NOT NULL,
      end_battery REAL,
      energy_added_kwh REAL,
      lat REAL,
      lon REAL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS idles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      start_battery REAL NOT NULL,
      end_battery REAL
    )
  `);

  // Tracked in-memory rather than re-derived, but every lookup below still goes through
  // the DB (not a cached id) so a crash/restart mid-session is still consistent: the open
  // row persists in SQLite and the next observe() after restart finds it via findOpen().
  let lastSnapshotAt: number | null = null;

  function findOpen(): OpenSession | null {
    const d = db.prepare(`SELECT id FROM drives WHERE ended_at IS NULL`).get() as
      | { id: number }
      | undefined;
    if (d) return { mode: "driving", id: d.id };
    const c = db.prepare(`SELECT id FROM charges WHERE ended_at IS NULL`).get() as
      | { id: number }
      | undefined;
    if (c) return { mode: "charging", id: c.id };
    const i = db.prepare(`SELECT id FROM idles WHERE ended_at IS NULL`).get() as
      | { id: number }
      | undefined;
    if (i) return { mode: "idle", id: i.id };
    return null;
  }

  // Updates an open row's end fields to this snapshot's values; `endedAt` is set only
  // when actually closing the row (null keeps it open).
  function touch(session: OpenSession, data: FleetVehicleData, endedAt: number | null): void {
    if (session.mode === "driving") {
      db.prepare(
        `UPDATE drives SET end_odometer = ?, end_battery = ?, end_lat = ?, end_lon = ?, ended_at = ? WHERE id = ?`,
      ).run(odometerOf(data), batteryOf(data), latOf(data), lonOf(data), endedAt, session.id);
    } else if (session.mode === "charging") {
      db.prepare(
        `UPDATE charges SET end_battery = ?, energy_added_kwh = ?, ended_at = ? WHERE id = ?`,
      ).run(batteryOf(data), energyAddedOf(data), endedAt, session.id);
    } else {
      db.prepare(`UPDATE idles SET end_battery = ?, ended_at = ? WHERE id = ?`).run(
        batteryOf(data),
        endedAt,
        session.id,
      );
    }
  }

  // Closes an already-current open row without touching its end fields — used for the
  // gap case, where the row's end fields are already correct from the last real snapshot
  // and all that's missing is stamping when it actually ended.
  function closeOnly(session: OpenSession, endedAt: number): void {
    const table = session.mode === "driving" ? "drives" : session.mode === "charging" ? "charges" : "idles";
    db.prepare(`UPDATE ${table} SET ended_at = ? WHERE id = ?`).run(endedAt, session.id);
  }

  function open(mode: Mode, data: FleetVehicleData, startedAt: number): void {
    if (mode === "driving") {
      const odometer = odometerOf(data);
      const battery = batteryOf(data);
      const lat = latOf(data);
      const lon = lonOf(data);
      db.prepare(
        `INSERT INTO drives (started_at, ended_at, start_odometer, end_odometer, start_battery, end_battery, start_lat, start_lon, end_lat, end_lon)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(startedAt, odometer, odometer, battery, battery, lat, lon, lat, lon);
    } else if (mode === "charging") {
      const battery = batteryOf(data);
      db.prepare(
        `INSERT INTO charges (started_at, ended_at, start_battery, end_battery, energy_added_kwh, lat, lon)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      ).run(startedAt, battery, battery, energyAddedOf(data), latOf(data), lonOf(data));
    } else {
      const battery = batteryOf(data);
      db.prepare(
        `INSERT INTO idles (started_at, ended_at, start_battery, end_battery) VALUES (?, NULL, ?, ?)`,
      ).run(startedAt, battery, battery);
    }
  }

  function observe(data: FleetVehicleData, atMs: number): void {
    if (lastSnapshotAt !== null && atMs - lastSnapshotAt > GAP_MS) {
      const stale = findOpen();
      if (stale) closeOnly(stale, lastSnapshotAt);
    }

    const mode = modeOf(data);
    const current = findOpen();

    if (current && current.mode === mode) {
      touch(current, data, null);
    } else {
      if (current) touch(current, data, atMs);
      open(mode, data, atMs);
    }

    lastSnapshotAt = atMs;
  }

  // Shared WHERE clause: all three tables filter on started_at the same way.
  function rangeClause(fromMs?: number, toMs?: number): { where: string; params: number[] } {
    const conditions: string[] = [];
    const params: number[] = [];
    if (fromMs !== undefined) {
      conditions.push(`started_at >= ?`);
      params.push(fromMs);
    }
    if (toMs !== undefined) {
      conditions.push(`started_at <= ?`);
      params.push(toMs);
    }
    return { where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "", params };
  }

  return {
    observe,
    drives(fromMs?: number, toMs?: number): DriveRow[] {
      const { where, params } = rangeClause(fromMs, toMs);
      const rows = db
        .prepare(`SELECT * FROM drives${where} ORDER BY started_at ASC`)
        .all(...params) as unknown as DriveRowData[];
      return rows.map(toDriveRow);
    },
    charges(fromMs?: number, toMs?: number): ChargeRow[] {
      const { where, params } = rangeClause(fromMs, toMs);
      const rows = db
        .prepare(`SELECT * FROM charges${where} ORDER BY started_at ASC`)
        .all(...params) as unknown as ChargeRowData[];
      return rows.map(toChargeRow);
    },
    idles(fromMs?: number, toMs?: number): IdleRow[] {
      const { where, params } = rangeClause(fromMs, toMs);
      const rows = db
        .prepare(`SELECT * FROM idles${where} ORDER BY started_at ASC`)
        .all(...params) as unknown as IdleRowData[];
      return rows.map(toIdleRow);
    },
  };
}
