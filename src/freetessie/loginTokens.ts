// LoginTokenStore: one-time links for the OAuth bootstrap. GET /auth/tesla/login is the
// only route that can start a flow ending in fleet_tokens being written, and it has to
// be reachable without a bearer (it runs in the owner's browser before any key exists)
// — so it demands a token only the operator can mint (`npm run freetessie:setup --
// login-url`). Hash-stored, single-use, 15-minute expiry; same sha256 + timingSafeEqual
// idiom as apiKeys.ts so the plaintext never lands in the database.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LoginTokenStore } from "./contracts.ts";

const TTL_MS = 15 * 60 * 1000;

interface LoginTokenRow {
  hash: string;
  expires_at: number;
  used_at: number | null;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )
  `);
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createLoginTokenStore(db: DatabaseSync, now: () => number = Date.now): LoginTokenStore {
  ensureSchema(db);

  return {
    mint(): string {
      const token = randomBytes(24).toString("base64url");
      db.prepare(`INSERT INTO login_tokens (hash, expires_at, used_at) VALUES (?, ?, NULL)`).run(
        hashToken(token).toString("hex"),
        now() + TTL_MS,
      );
      return token;
    },

    consume(token: string): boolean {
      const candidate = hashToken(token);
      const at = now();
      const rows = db
        .prepare(`SELECT hash, expires_at, used_at FROM login_tokens`)
        .all() as unknown as LoginTokenRow[];
      let matched: string | null = null;
      for (const row of rows) {
        const stored = Buffer.from(row.hash, "hex");
        // Compare every row to full length so a used/expired token costs the same as a
        // live one — no timing tell about which rows exist.
        const equal = candidate.length === stored.length && timingSafeEqual(candidate, stored);
        if (equal && row.used_at === null && row.expires_at > at) matched = row.hash;
      }
      if (!matched) return false;
      db.prepare(`UPDATE login_tokens SET used_at = ? WHERE hash = ?`).run(at, matched);
      // Opportunistic sweep so the table never grows past a handful of rows.
      db.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).run(at);
      return true;
    },
  };
}
