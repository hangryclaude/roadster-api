// State cache: the last vehicle_data snapshot, kept warm so GET /{vin}/state's default
// (cached) path never costs a Fleet API call. Single row — one owner, one car.

import type { DatabaseSync } from "node:sqlite";
import type { FleetVehicleData, StateCache } from "./contracts.ts";

interface CacheRow {
  data: string;
  fetched_at: number;
}

export function createStateCache(db: DatabaseSync): StateCache {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_state_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  return {
    get(): { data: FleetVehicleData; fetchedAt: number } | null {
      const row = db
        .prepare(`SELECT data, fetched_at FROM vehicle_state_cache WHERE id = 1`)
        .get() as CacheRow | undefined;
      if (!row) return null;
      return { data: JSON.parse(row.data) as FleetVehicleData, fetchedAt: row.fetched_at };
    },
    put(data: FleetVehicleData, fetchedAt: number): void {
      // Single row by construction (id is pinned to 1 and checked) — upsert rather than
      // delete+insert so a reader never sees a momentarily-empty cache.
      db.prepare(
        `INSERT INTO vehicle_state_cache (id, data, fetched_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      ).run(JSON.stringify(data), fetchedAt);
    },
  };
}
