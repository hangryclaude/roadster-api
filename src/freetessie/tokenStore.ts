// TokenStore: single-row persisted Tesla OAuth token state (single owner, single car).
// Tesla rotates the refresh token on every refresh and only grants a 24-hour grace
// window on the just-superseded one — a lost write here mid-crash is a real lockout,
// so save() is one atomic UPSERT wrapped in an explicit transaction, never two statements.

import type { DatabaseSync } from "node:sqlite";
import type { OwnerTokens, TokenStore } from "./contracts.ts";

interface TokenRow {
  id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  dead: number;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      scope TEXT NOT NULL,
      dead INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function rowToTokens(row: TokenRow): OwnerTokens {
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    scope: row.scope,
    dead: row.dead !== 0,
  };
}

export function createTokenStore(db: DatabaseSync): TokenStore {
  ensureSchema(db);

  return {
    load(): OwnerTokens | null {
      const row = db.prepare(`SELECT * FROM fleet_tokens WHERE id = 1`).get() as
        | TokenRow
        | undefined;
      return row ? rowToTokens(row) : null;
    },

    save(tokens: OwnerTokens): void {
      // BEGIN IMMEDIATE takes the write lock up front so a concurrent writer blocks
      // here rather than racing into a half-applied row.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO fleet_tokens (id, access_token, refresh_token, expires_at, scope, dead)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             access_token = excluded.access_token,
             refresh_token = excluded.refresh_token,
             expires_at = excluded.expires_at,
             scope = excluded.scope,
             dead = excluded.dead`,
        ).run(
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresAt,
          tokens.scope,
          tokens.dead ? 1 : 0,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    markDead(): void {
      // No-op if the row doesn't exist yet — nothing has ever been persisted to mark dead.
      db.prepare(`UPDATE fleet_tokens SET dead = 1 WHERE id = 1`).run();
    },
  };
}
