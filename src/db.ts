import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { createCorsairDatabase } from 'corsair/db';
import type { CorsairDatabaseInput } from 'corsair/db';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CORSAIR_DB_PATH ?? path.resolve(__dirname, '..', 'corsair.db');

// ---- Adapter: node:sqlite → Kysely SqliteDatabase interface ─────────────────
//
// Corsair's createCorsairDatabase checks for { prepare, exec, close } to detect
// a better-sqlite3-compatible database and wraps it with SqliteDialect + its
// own Date serialization plugin automatically.
//
// node:sqlite (built into Node.js 22.5+, no native binaries) has the same three
// methods, so the check passes. The only differences are:
//   1. StatementSync.all/run take spread args, not a single array.
//   2. StatementSync has no `.reader` property — we derive it from the SQL text.
//   3. StatementSync.iterate() exists in Node 22.6+ — we add a fallback.

class NodeSqliteAdapter {
  constructor(private raw: DatabaseSync) {}

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }

  prepare(sql: string) {
    const stmt = this.raw.prepare(sql);
    // Kysely uses `reader` to decide between .all() and .run().
    const isReader = /^\s*(select|with|pragma)/i.test(sql.trim());

    return {
      reader: isReader,

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all(params: ReadonlyArray<unknown>): unknown[] {
        return (stmt as any).all(...params) as unknown[];
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run(params: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
        const r = (stmt as any).run(...params) as { changes: number; lastInsertRowid: number };
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
      },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      iterate(params: ReadonlyArray<unknown>): IterableIterator<unknown> {
        const s = stmt as any;
        if (typeof s.iterate === 'function') return s.iterate(...params) as IterableIterator<unknown>;
        // Fallback: materialise via all() and wrap in an iterator.
        const rows = s.all(...params) as unknown[];
        let i = 0;
        const iter: IterableIterator<unknown> = {
          [Symbol.iterator]() { return iter; },
          next() {
            return i < rows.length
              ? { value: rows[i++], done: false as const }
              : { value: undefined, done: true as const };
          },
        };
        return iter;
      },
    };
  }
}

// ---- Database setup ─────────────────────────────────────────────────────────

const rawDb = new DatabaseSync(dbPath);

// Create the corsair_permissions table on first run.
// Only this table is needed — we use direct plugin credentials, not DB-backed auth.
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS corsair_permissions (
    id          TEXT     PRIMARY KEY,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    token       TEXT     NOT NULL UNIQUE,
    plugin      TEXT     NOT NULL,
    endpoint    TEXT     NOT NULL,
    args        TEXT     NOT NULL,
    tenant_id   TEXT     NOT NULL DEFAULT 'default',
    status      TEXT     NOT NULL DEFAULT 'pending',
    expires_at  TEXT     NOT NULL,
    error       TEXT
  )
`);

console.log(`[db] SQLite database ready at ${dbPath}`);

// The adapter satisfies the runtime shape check (has prepare/exec/close) inside
// createCorsairDatabase, which wraps it with SqliteDialect + Date serialisation.
const adapter = new NodeSqliteAdapter(rawDb) as unknown as CorsairDatabaseInput;

/**
 * Raw adapter — pass this to createCorsair({ database: rawDbInput }) so that
 * Corsair's own createCorsairDatabase wraps it with the right dialect + plugin.
 */
export const rawDbInput: CorsairDatabaseInput = adapter;

/**
 * Wrapped Kysely DB — use this in server.ts for direct corsair_permissions queries.
 */
export const corsairDb = createCorsairDatabase(adapter);
