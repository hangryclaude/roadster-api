// SQLite triggers table schema + queries.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Trigger {
  id: string;
  channel: "telegram" | "twilio";
  chatId: string; // Telegram chat id or E.164 phone number
  toolName: string;
  toolArgs: Record<string, unknown>;
  fireAt: number; // unix ms
  status: "pending" | "fired" | "cancelled";
  createdAt: number;
  replyContext: string; // what prompted this, echoed back in the fired-confirmation
  // See ScheduleRequest.pinVerified — persisted so the poller can re-check it at fire
  // time without trusting anything about the schedule-time call.
  pinVerified: boolean;
}

let schemaEnsured = false;

function ensureSchema(db: DatabaseSync): void {
  // Cheap idempotent guard — avoids re-running CREATE TABLE on every call within the
  // same process, but still safe across separate DatabaseSync instances since the SQL
  // itself is IF NOT EXISTS.
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
  schemaEnsured = true;
}

function rowToTrigger(row: Record<string, unknown>): Trigger {
  return {
    id: row.id as string,
    channel: row.channel as Trigger["channel"],
    chatId: row.chat_id as string,
    toolName: row.tool_name as string,
    toolArgs: JSON.parse(row.tool_args_json as string),
    fireAt: Number(row.fire_at),
    status: row.status as Trigger["status"],
    createdAt: Number(row.created_at),
    replyContext: row.reply_context as string,
    pinVerified: Boolean(row.pin_verified),
  };
}

export function scheduleTrigger(
  db: DatabaseSync,
  t: Omit<Trigger, "id" | "status" | "createdAt" | "pinVerified"> & { pinVerified?: boolean },
): Trigger {
  ensureSchema(db);
  const trigger: Trigger = {
    ...t,
    id: randomUUID(),
    status: "pending",
    createdAt: Date.now(),
    pinVerified: t.pinVerified ?? true,
  };
  db.prepare(
    `INSERT INTO triggers (id, channel, chat_id, tool_name, tool_args_json, fire_at, status, created_at, reply_context, pin_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trigger.id,
    trigger.channel,
    trigger.chatId,
    trigger.toolName,
    JSON.stringify(trigger.toolArgs),
    trigger.fireAt,
    trigger.status,
    trigger.createdAt,
    trigger.replyContext,
    trigger.pinVerified ? 1 : 0,
  );
  return trigger;
}

export function cancelLatestPending(
  db: DatabaseSync,
  channel: Trigger["channel"],
  chatId: string,
): Trigger | null {
  ensureSchema(db);
  const row = db
    .prepare(
      `SELECT * FROM triggers WHERE channel = ? AND chat_id = ? AND status = 'pending'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(channel, chatId) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare(`UPDATE triggers SET status = 'cancelled' WHERE id = ?`).run(row.id as string);
  return { ...rowToTrigger(row), status: "cancelled" };
}

export function dueTriggers(db: DatabaseSync, nowMs: number): Trigger[] {
  ensureSchema(db);
  const rows = db
    .prepare(`SELECT * FROM triggers WHERE status = 'pending' AND fire_at <= ?`)
    .all(nowMs) as Record<string, unknown>[];
  return rows.map(rowToTrigger);
}

export function markFired(db: DatabaseSync, id: string): void {
  ensureSchema(db);
  db.prepare(`UPDATE triggers SET status = 'fired' WHERE id = ?`).run(id);
}
