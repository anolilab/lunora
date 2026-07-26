import { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { handleAuthRequest } from "../src/handler";
import type { SqlExecutor } from "../src/sql-store";
import { createSqlAuthStore } from "../src/sql-store";

/**
 * Reproduces the E2E `mail-reset.spec.ts` failure at the worker/auth boundary
 * (no browser): sign-up over HTTP succeeds, but `POST /api/auth/forget-password`
 * 404s. Drives the real better-auth handler through Lunora's `handleAuthRequest`
 * + SQL store over in-memory SQLite — the same path the deployed worker takes.
 */

const SECRET = "lunora-forget-pw-secret-lunora-forget-pw-xxxxxx";
const EMAIL = "ada@example.com";
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow

let database: DatabaseSync;

const executorFor = (database_: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(database_.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            database_.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

const affinity = (type: ReadonlyArray<string> | string): string => {
    if (type === "number") {
        return "REAL";
    }

    if (type === "boolean") {
        return "INTEGER";
    }

    return "TEXT";
};

const materialiseSchema = (database_: DatabaseSync, options: Parameters<typeof getAuthTables>[0]): void => {
    for (const table of Object.values(getAuthTables(options))) {
        const columns = [
            `"id" TEXT PRIMARY KEY`,
            ...Object.entries(table.fields).map(([field, attribute]) => `"${attribute.fieldName ?? field}" ${affinity(attribute.type)}`),
        ];

        database_.exec(`CREATE TABLE "${table.modelName}" (${columns.join(", ")})`);
    }
};

const jsonRequest = (path: string, body: unknown): Request =>
    new Request(`http://localhost:3000${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        method: "POST",
    });

describe("auth — /api/auth/forget-password HTTP route", () => {
    const baseOptions = {
        baseURL: "http://localhost:3000",
        emailAndPassword: {
            enabled: true,
            // The presence of `sendResetPassword` is what enables the
            // forget-password endpoint in better-auth.
            sendResetPassword: async () => {},
        },
        secret: SECRET,
    } as const;

    const buildAuth = () =>
        createAuth({
            ...baseOptions,
            database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))),
        });

    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        // Materialise the schema from the SAME resolved options `createAuth` runs
        // with (and `compileMigrationsSql` migrates from), so `getAuthTables` emits
        // the `rateLimit` table better-auth's default-on durable limiter writes to.
        materialiseSchema(database, resolveAuthOptions(baseOptions));
    });

    afterEach(() => {
        database.close();
    });

    it("sign-up succeeds and the password-reset request returns 200", async () => {
        expect.assertions(2);

        const auth = buildAuth();

        const signup = await handleAuthRequest(auth, jsonRequest("/api/auth/sign-up/email", { email: EMAIL, name: EMAIL, password: PASSWORD }));

        expect(signup?.status).toBe(200);

        // better-auth ≥1.6 serves the request at `/request-password-reset`; the old
        // `/forget-password` path was removed (it 404s) — the E2E `mail-reset` flake.
        const reset = await handleAuthRequest(
            auth,
            jsonRequest("/api/auth/request-password-reset", { email: EMAIL, redirectTo: "http://localhost:3000/reset" }),
        );

        expect(reset?.status).toBe(200);
    });

    it("the removed `/forget-password` path now 404s (guards the rename)", async () => {
        expect.assertions(1);

        const auth = buildAuth();

        const legacy = await handleAuthRequest(auth, jsonRequest("/api/auth/forget-password", { email: EMAIL }));

        expect(legacy?.status).toBe(404);
    });
});
