// Conversation memory: last 20 turns per chat, in SQLite via node:sqlite (built in,
// no native deps per package.json's dependency policy).

import type { DatabaseSync } from "node:sqlite";

export interface MemoryTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

const MAX_TURNS = 20;

export function ensureMemorySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

export function addTurn(
  db: DatabaseSync,
  chatId: string,
  role: "user" | "assistant",
  content: string,
): void {
  db.prepare(
    `INSERT INTO agent_memory (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
  ).run(chatId, role, content, Date.now());

  // Trim to the last MAX_TURNS rows for this chat so the table never grows unbounded
  // and getRecentTurns never has to paginate.
  const rows = db
    .prepare(`SELECT id FROM agent_memory WHERE chat_id = ? ORDER BY id DESC`)
    .all(chatId) as Array<{ id: number }>;
  if (rows.length > MAX_TURNS) {
    const dropIds = rows.slice(MAX_TURNS).map((r) => r.id);
    const placeholders = dropIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM agent_memory WHERE id IN (${placeholders})`).run(...dropIds);
  }
}

export function getRecentTurns(db: DatabaseSync, chatId: string, limit = MAX_TURNS): MemoryTurn[] {
  const rows = db
    .prepare(
      `SELECT role, content, created_at FROM agent_memory WHERE chat_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(chatId, limit) as Array<{ role: string; content: string; created_at: number }>;
  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
    createdAt: r.created_at,
  }));
}
