import type { SqlExec } from "@lunora/sql-store";
import { createDB } from "mysql-memory-server";
import mysql from "mysql2/promise";

import type { Mysql2Execute } from "../../src/global-exec";
import { buildMysqlExec } from "../../src/global-exec";

/**
 * Adapts a **real MySQL 8.0** server (downloaded + spawned by
 * [`mysql-memory-server`](https://www.npmjs.com/package/mysql-memory-server) —
 * no Docker, no external service) to the async {@link SqlExec} the store core
 * consumes, via the package's own {@link buildMysqlExec} adapter.
 *
 * This is the third real-engine gate, alongside the D1 suite's `node:sqlite` and
 * the pglite Postgres suite. It proves the MySQL SQL the core renders through
 * drizzle (backtick identifiers, `?` placeholders, `ON DUPLICATE KEY` upserts,
 * `information_schema` probes, affected-rows OCC) actually runs — including the
 * `CLIENT_FOUND_ROWS` requirement (set here) without which an idempotent
 * `patch`/`replace` would raise a spurious OCC conflict.
 *
 * Startup is slow (mysqld download on first run, then ~spawn), so callers share
 * one server across a suite via `beforeAll` and reset tables per test.
 */
interface MysqlHarness {
    /** Stop the connection and the mysqld process. */
    close: () => Promise<void>;
    /** Connection details, e.g. for building an `env.HYPERDRIVE`-shaped binding double. */
    connection: { database: string; host: string; port: number; user: string };
    /** The {@link SqlExec} the store core / migrations run against (wraps `connection.execute`). */
    exec: SqlExec;
    /** Raw query escape hatch (text protocol) for assertions + per-test table resets. */
    query: (sql: string, parameters?: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
}

const createMysqlHarness = async (): Promise<MysqlHarness> => {
    const database = await createDB({ version: "8.0.x" });
    const connection = await mysql.createConnection({
        database: database.dbName,
        // The store's affected-rows OCC guard needs matched- (not changed-) row counts.
        flags: ["FOUND_ROWS"],
        host: "127.0.0.1",
        port: database.port,
        user: database.username,
    });

    return {
        close: async () => {
            await connection.end();
            await database.stop?.();
        },
        connection: { database: database.dbName, host: "127.0.0.1", port: database.port, user: database.username },
        // mysql2's overloaded `execute` doesn't structurally match Mysql2Execute, but the runtime shape is exactly it.
        exec: buildMysqlExec(connection as unknown as Mysql2Execute),
        query: async (sql, parameters = []) => {
            const [rows] = await connection.query(sql, parameters as unknown[]);

            return rows as Record<string, unknown>[];
        },
    };
};

/**
 * Like {@link createMysqlHarness}, but gated on the environment actually being
 * able to provision mysqld: `mysql-memory-server` downloads the MySQL binary on
 * first use, and restricted sandboxes (e.g. an egress proxy answering the CDN
 * with HTTP 403) make that download impossible. Suites consume this and skip —
 * with the captured reason — instead of failing on an environment limitation.
 */
const tryCreateMysqlHarness = async (): Promise<{ harness?: MysqlHarness; unavailable?: string }> => {
    try {
        return { harness: await createMysqlHarness() };
    } catch (error) {
        return { unavailable: `mysql-memory-server could not provision mysqld in this environment: ${error instanceof Error ? error.message : String(error)}` };
    }
};

export type { MysqlHarness };
export { createMysqlHarness, tryCreateMysqlHarness };
