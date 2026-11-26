import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { LunoraAuthOptions } from "../../src/create-auth";
import { resolveAuthOptions } from "../../src/create-auth";
import { convertAuthDatesToEpochMs } from "../../src/dates";
import { authDoSchemaStatements } from "../../src/do-schema";
import { doExecutor } from "../../src/do-store";
import { ensureMigrated } from "../../src/migrate";
import { d1Executor } from "../../src/sql-store";

/**
 * The date conversion runs in SQL (`julianday`, `GLOB`), so it is pinned on
 * workerd's SQLite: `node:sqlite` is a different build behind a different authorizer.
 */

const options: LunoraAuthOptions = { emailAndPassword: { enabled: true }, secret: "lunora-workerd-convert-dates-secret-lunora-xx" };
const LEGACY = "2020-01-01T00:00:00.123Z";

describe("convertAuthDatesToEpochMs on workerd SQLite", () => {
    it("converts ISO strings to exact epoch ms in a Durable Object's storage", async () => {
        expect.assertions(5);

        const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName("convert-dates"));

        await runInDurableObject(stub, async (_instance, state) => {
            for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
                [...state.storage.sql.exec(statement)];
            }

            [
                ...state.storage.sql.exec(
                    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.com', 0, ?, ?)`,
                    LEGACY,
                    1_700_000_000_000,
                ),
            ];

            const executor = doExecutor(state.storage);

            await expect(convertAuthDatesToEpochMs(executor, options)).resolves.toStrictEqual([{ converted: 1, table: "user" }]);

            const [row] = [...state.storage.sql.exec(`SELECT "createdAt", "updatedAt" FROM "user" WHERE "id" = 'u1'`)];

            expect(row).toStrictEqual({ createdAt: Date.parse(LEGACY), updatedAt: 1_700_000_000_000 });
            await expect(convertAuthDatesToEpochMs(executor, options)).resolves.toStrictEqual([]);

            // An app-managed plugin table is probed through `sqlite_master`, which DO storage allows.
            const appOwned = {
                id: "app-owned",
                schema: { appGrant: { disableMigration: true, fields: { expiresAt: { required: true, type: "date" } } } },
            } as const;

            await expect(convertAuthDatesToEpochMs(executor, { ...options, plugins: [appOwned] })).resolves.toStrictEqual([]);

            // Once it exists, its declared column types are read with `PRAGMA table_info`, which DO storage allows too.
            [...state.storage.sql.exec(`CREATE TABLE "appGrant" ("id" TEXT PRIMARY KEY, "expiresAt" TEXT)`)];

            const error = vi.spyOn(console, "error").mockImplementation(() => {});

            await convertAuthDatesToEpochMs(executor, { ...options, plugins: [appOwned] });

            const logged = error.mock.calls.map((call) => String(call[0]));

            error.mockRestore();

            expect(logged).toStrictEqual([expect.stringContaining("appGrant.expiresAt is a date column with text affinity")]);
        });
    });

    it("runs the same SQL functions through D1's authorizer", async () => {
        expect.assertions(1);

        const [row] = await d1Executor(env.TEST_DB).all(
            `SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000) AS INTEGER) AS "millis", (? GLOB '*[^0-9.-]*') AS "iso", ('1700000000000' GLOB '*[^0-9.-]*') AS "digits"`,
            [LEGACY, LEGACY],
        );

        expect(row).toStrictEqual({ digits: 0, iso: 1, millis: Date.parse(LEGACY) });
    });

    it("reads declared column types through D1's authorizer", async () => {
        expect.assertions(1);

        await env.TEST_DB.prepare(`CREATE TABLE "dates_affinity" ("id" TEXT PRIMARY KEY, "expiresAt" TEXT)`).run();

        const rows = await d1Executor(env.TEST_DB).all(`PRAGMA table_info("dates_affinity")`, []);

        expect(rows.map((row) => [row["name"], row["type"]])).toStrictEqual([
            ["id", "TEXT"],
            ["expiresAt", "TEXT"],
        ]);
    });

    it("runs on D1 as part of ensureMigrated", async () => {
        expect.assertions(1);

        const migrationOptions: LunoraAuthOptions = {
            ...options,
            account: { modelName: "dates_account" },
            database: env.TEST_DB,
            rateLimit: { modelName: "dates_rate_limit" },
            session: { modelName: "dates_session" },
            user: { modelName: "dates_user" },
            verification: { modelName: "dates_verification" },
        };

        await ensureMigrated({ options: migrationOptions });
        // As if an earlier version had created the tables: no conversion recorded yet.
        await env.TEST_DB.prepare(`DELETE FROM "__lunora_auth_backfill__" WHERE "name" = 'dates-epoch-ms'`).run();
        await env.TEST_DB.prepare(
            `INSERT INTO "dates_verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ('v1', 'i', 'x', ?, ?, ?)`,
        )
            .bind(LEGACY, LEGACY, LEGACY)
            .run();

        // A fresh options object: the migration and its passes are single-flighted per reference.
        await ensureMigrated({ options: { ...migrationOptions } });

        await expect(env.TEST_DB.prepare(`SELECT "expiresAt" FROM "dates_verification" WHERE "id" = 'v1'`).first()).resolves.toStrictEqual({
            expiresAt: Date.parse(LEGACY),
        });
    });
});
