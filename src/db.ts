import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Tiny query interface shared by both backends:
 *  - DATABASE_URL set  -> real Postgres via `pg` (e.g. the docker-compose service)
 *  - otherwise         -> embedded PGlite (Postgres compiled to WASM), persisted to PGLITE_DIR
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** A transaction that can also run multi-statement SQL (a migration file). */
export interface Execable extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  /** Run fn inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /**
   * Run fn in one transaction holding the migration lock, so no other process migrates at the same time (concurrent
   * ALTERs deadlock). Used by src/migrate.ts; rolls back if fn throws.
   */
  migrate<T>(fn: (tx: Execable) => Promise<T>): Promise<T>;
  kind: "postgres" | "pglite";
}

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    // Return NUMERIC and BIGINT (e.g. count(*)) as JS numbers.
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
    pg.types.setTypeParser(pg.types.builtins.INT8, Number);
    const pool = new pg.Pool({ connectionString: url });
    // An idle pooled connection the server ends (a restart, a dropped database, a pooler recycling) must not crash the
    // process: node-pg emits it on the pool, and an unhandled 'error' event is fatal.
    pool.on("error", (err) => console.error("database: idle connection error:", err.message));
    return {
      kind: "postgres",
      async query(sql, params) {
        return (await pool.query(sql, params)).rows;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
          await client.query("COMMIT");
          client.release();
          return result;
        } catch (err) {
          // A connection whose ROLLBACK failed may still be inside the transaction: destroy it, never pool it.
          await client.query("ROLLBACK").then(() => client.release(), (e) => client.release(e as Error));
          throw err;
        }
      },
      close: () => pool.end(),
      // Replicas starting together (rolling deploys, serverless cold starts) would run the same migrations at once:
      // they take turns on a transaction-level advisory lock, and the second one finds nothing pending
      // (src/migrate.ts re-reads what is applied after taking the lock). Transaction-level, not session-level, so it
      // is released at COMMIT even behind a transaction-pooling proxy (PgBouncer, Neon's pooler), where a session lock
      // can be taken on one server connection and "released" on another.
      async migrate(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Bounded waits: behind a long query, a migration's table locks would queue all traffic, and the advisory lock
          // could hang a deploy. Fail instead (db:migrate retries; a boot's next request tries again).
          await client.query("SET LOCAL lock_timeout = '15s'");
          await client.query("SELECT pg_advisory_xact_lock(7270010)");
          // No params: the simple query protocol, so a migration file may hold many statements.
          const result = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows, exec: async (sql) => void (await client.query(sql)) });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }

  const { PGlite, types } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DIR ?? path.resolve(SQL_DIR, "..", ".pglite");
  const lite = await PGlite.create(dataDir, {
    parsers: { [types.NUMERIC]: Number, [types.INT8]: Number },
  });
  return {
    kind: "pglite",
    async query(sql, params) {
      return (await lite.query(sql, params)).rows as never[];
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    transaction: (fn) =>
      lite.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never[] })),
    close: () => lite.close(),
    // One process per PGlite directory: no lock to take, only the transaction.
    migrate: (fn) => lite.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never[], exec: async (sql) => void (await tx.exec(sql)) })),
  };
}

let dbPromise: Promise<Db> | undefined;

/** A connection of its own, without the migration step getDb runs (scripts/migrate.ts). The caller closes it. */
export const openDb = (): Promise<Db> => createDb();

/**
 * Shared connection. On first use it brings the schema up to date: the versioned migrations in sql/migrations that
 * this database has not applied yet (src/migrate.ts), or, with OCTILLION_MIGRATE_ON_BOOT=off, it only checks that
 * none are pending (a deploy step runs `npm run db:migrate` first) and refuses to start otherwise.
 */
export function getDb(): Promise<Db> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await createDb();
    try {
      const { ensureMigrated } = await import("./migrate.js");
      await ensureMigrated(db);
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
    return db;
  })();
  // A failed start (the database restarting, a network blip) must not stick: the next caller tries again.
  dbPromise.catch(() => { dbPromise = undefined; });
  return dbPromise;
}

/** Destructive: drop every table, then recreate the schema from the migrations. Local development only. */
export async function resetDb(db: Db): Promise<void> {
  // Everything in the schema, not a list that falls behind new tables.
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const { runMigrations } = await import("./migrate.js");
  await runMigrations(db);
}
