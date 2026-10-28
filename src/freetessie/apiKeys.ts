// ApiKeyStore: the local bearer "API key" freetessie mints — this is the Tessie-shaped
// token TessieAdapter sends as TESSIE_TOKEN. Same hash-and-timingSafeEqual idiom as
// hashPin/pinMatches in src/agent/agent.ts: only a sha256 hash is ever persisted, and
// comparison never short-circuits on a mismatched byte in a way that leaks timing.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ApiKeyRecord, ApiKeyStore } from "./contracts.ts";

interface ApiKeyRow {
  id: string;
  hash: string;
  label: string;
  created_at: number;
  revoked_at: number | null;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `);
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createApiKeyStore(db: DatabaseSync): ApiKeyStore {
  ensureSchema(db);

  return {
    mint(label: string): { id: string; token: string } {
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      db.prepare(
        `INSERT INTO api_keys (id, hash, label, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
      ).run(id, hashToken(token).toString("hex"), label, Date.now());
      return { id, token }; // the only moment the plaintext exists outside the caller's hand
    },

    verify(token: string): boolean {
      const candidateHash = hashToken(token);
      const rows = db.prepare(`SELECT id, hash, revoked_at FROM api_keys`).all() as Array<
        Pick<ApiKeyRow, "id" | "hash" | "revoked_at">
      >;
      let matched = false;
      for (const row of rows) {
        const storedHash = Buffer.from(row.hash, "hex");
        // Keep comparing every row rather than returning on the first hit, so a
        // revoked key's hash still costs a full compare instead of an early-out
        // that could leak which branch (match vs no-match) was taken via timing.
        const isEqual =
          candidateHash.length === storedHash.length && timingSafeEqual(candidateHash, storedHash);
        if (isEqual && row.revoked_at === null) {
          matched = true;
        }
      }
      return matched;
    },

    revoke(id: string): void {
      db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(Date.now(), id);
    },

    list(): ApiKeyRecord[] {
      const rows = db
        .prepare(`SELECT id, label, created_at, revoked_at FROM api_keys ORDER BY created_at ASC`)
        .all() as Array<Pick<ApiKeyRow, "id" | "label" | "created_at" | "revoked_at">>;
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      }));
    },
  };
}
