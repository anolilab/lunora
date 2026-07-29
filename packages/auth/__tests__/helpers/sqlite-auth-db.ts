import type { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";

import type { LunoraAuthOptions } from "../../src/create-auth";
import { resolveAuthOptions } from "../../src/create-auth";
import type { SqlExecutor } from "../../src/sql-store";

/**
 * Shared `node:sqlite` backing for the suites that drive a **real** better-auth instance
 * over Lunora's SQL store.
 *
 * Shared rather than copied for the reason `helpers/do-storage.ts` gives about its own
 * double: the copies drift on the one detail that matters. They already had —
 * `integration.test.ts` materialised its schema from *raw* options while
 * `forget-password-route.test.ts` used resolved ones and carried a comment explaining
 * why raw is wrong. {@link materialiseAuthSchema} resolves internally so that divergence
 * cannot recur.
 */

/**
 * A {@link SqlExecutor} over an in-memory SQLite database.
 *
 * `DatabaseSync` is synchronous, so both methods resolve immediately; the async signature
 * exists to satisfy the executor seam D1 (genuinely async) also implements.
 */
export const executorFor = (database: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

/** SQLite column affinity for a better-auth field type. */
const affinity = (type: ReadonlyArray<string> | string): string => {
    if (type === "number") {
        return "REAL";
    }

    if (type === "boolean") {
        return "INTEGER";
    }

    return "TEXT";
};

/**
 * Materialise the tables `createAuth(options)` will actually read, so the store works
 * against real tables rather than implicit-table fakery.
 *
 * Takes the **caller's** options and resolves them here on purpose. The defaults
 * `resolveAuthOptions` fills change which tables `getAuthTables` emits — most visibly the
 * `rateLimit` table better-auth's default-on durable limiter writes to — and a missing one
 * surfaces as an opaque SQL error much later. Folding the resolve in means no caller can
 * pass raw options and get a subtly incomplete schema.
 */
export const materialiseAuthSchema = (database: DatabaseSync, options: LunoraAuthOptions): void => {
    for (const table of Object.values(getAuthTables(resolveAuthOptions(options)))) {
        const columns = [
            `"id" TEXT PRIMARY KEY`,
            ...Object.entries(table.fields).map(([field, attribute]) => `"${attribute.fieldName ?? field}" ${affinity(attribute.type)}`),
        ];

        database.exec(`CREATE TABLE "${table.modelName}" (${columns.join(", ")})`);
    }
};
