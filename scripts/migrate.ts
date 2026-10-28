// Create triggers table + any future tables. Idempotent (CREATE TABLE IF NOT EXISTS).

import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
  // Column names here must match src/scheduler/triggers.ts's own ensureSchema
  // exactly (snake_case) — that module re-runs CREATE TABLE IF NOT EXISTS on first
  // use regardless, so a mismatched schema created here first would otherwise win
  // and every triggers.ts query would fail against it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args_json TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reply_context TEXT NOT NULL,
      pin_verified INTEGER NOT NULL DEFAULT 1
    )
  `);
}
