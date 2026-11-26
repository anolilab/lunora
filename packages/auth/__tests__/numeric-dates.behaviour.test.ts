import { DatabaseSync } from "node:sqlite";

import { createD1CtxDb, runD1GlobalTableMigrations } from "@lunora/d1";
import type { TableDefinition } from "@lunora/server";
import { defineSchema } from "@lunora/server";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH } from "../src/auth-do";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { createSqlAuthDataPort } from "../src/data-port";
import { decodeAuthDate } from "../src/date-codec";
import { convertAuthDatesOnce, convertAuthDatesToEpochMs } from "../src/dates";
import { authDoSchemaStatements } from "../src/do-schema";
import { admin } from "../src/plugins";
import authTables from "../src/schema";
import type { SqlExecutor } from "../src/sql-store";
import { createSqlAuthStore } from "../src/sql-store";
import createDoStorage from "./helpers/do-storage";
import { executorFor } from "./helpers/sqlite-auth-db";

/**
 * better-auth writes its rows through `lunoraAuthAdapter`; Lunora then patches the same rows
 * through its own D1 writer, which re-validates the whole row against `authTables`'
 * `v.date()` (epoch-ms) columns. Both sides run here on one real SQLite database, with the
 * tables provisioned by Lunora's own DDL, as `lunora migrate` / the D1 auto-provisioner
 * would create them.
 */

const options: LunoraAuthOptions = {
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    plugins: [admin()],
    secret: "lunora-numeric-dates-secret-lunora-numeric-dates",
};

const EMAIL = "ada@example.com";
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow
const HOUR_MS = 60 * 60 * 1000;

/** The auth tables as an app declares them for Lunora's D1 writer: `.global()`. */
const schema = defineSchema(
    Object.fromEntries(
        Object.entries(authTables(resolveAuthOptions(options))).map(([name, table]) => [
            name,
            (table as unknown as { global: () => TableDefinition }).global(),
        ]),
    ),
);

let database: DatabaseSync;
let executor: SqlExecutor;

const buildAuth = (): LunoraAuth =>
    createAuth({ ...options, database: lunoraAuthAdapter(createSqlAuthStore(executor)), session: { cookieCache: { enabled: false } } });

const lunoraWriter = (): ReturnType<typeof createD1CtxDb> => createD1CtxDb({ clock: () => Date.now(), exec: executor, schema: schema as never });

const signUp = async (auth: LunoraAuth): Promise<string> => {
    const { user } = await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: PASSWORD } });

    return user.id;
};

const storageType = (table: string, column: string, id: string): unknown =>
    (database.prepare(`SELECT typeof("${column}") AS "kind" FROM "${table}" WHERE "id" = ?`).get(id) as { kind: string } | undefined)?.kind;

describe("lunoraAuthAdapter — dates stored as epoch ms", () => {
    beforeEach(async () => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
        await runD1GlobalTableMigrations(executor, schema as never);
    });

    afterEach(() => {
        database.close();
    });

    it("lets Lunora patch an unrelated column on a row better-auth wrote", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);

        expect(storageType("user", "createdAt", userId)).toBe("real");

        await expect(lunoraWriter().patch("user", userId, { role: "admin" })).resolves.not.toThrow();

        const row = database.prepare(`SELECT "role", "createdAt" FROM "user" WHERE "id" = ?`).get(userId) as { createdAt: number; role: string };

        expect(row.role).toBe("admin");
        expect(typeof row.createdAt).toBe("number");
    });

    it("hands better-auth Dates back, before and after a Lunora patch", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        const { adapter } = await auth.$context;

        const before = await adapter.findOne<{ createdAt: Date }>({ model: "user", where: [{ field: "id", value: userId }] });

        expect(before?.createdAt).toBeInstanceOf(Date);

        await lunoraWriter().patch("user", userId, { name: "Ada L." });

        const after = await adapter.findOne<{ createdAt: Date; name: string }>({ model: "user", where: [{ field: "id", value: userId }] });

        expect(after?.name).toBe("Ada L.");
        expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());

        // A session still resolves end to end through the numeric expiry.
        const signedIn = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } });

        expect(signedIn.token).toEqual(expect.any(String));
    });

    it("compares a date where clause against the stored number", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        await signUp(auth);
        const { adapter } = await auth.$context;
        const now = new Date();

        // Sign-up opens one session, expiring in the future.
        await expect(adapter.count({ model: "session", where: [{ field: "expiresAt", operator: "gt", value: now }] })).resolves.toBe(1);
        await expect(adapter.count({ model: "session", where: [{ field: "expiresAt", operator: "lt", value: now }] })).resolves.toBe(0);
        await expect(
            adapter.count({ model: "session", where: [{ field: "expiresAt", operator: "lt", value: new Date(now.getTime() + 30 * 24 * HOUR_MS) }] }),
        ).resolves.toBe(1);
    });
});

describe("convertAuthDatesToEpochMs — rows written as ISO strings", () => {
    const LEGACY_EXPIRY = "2020-01-01T00:00:00.123Z";

    beforeEach(async () => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
        await runD1GlobalTableMigrations(executor, schema as never);
    });

    afterEach(() => {
        database.close();
    });

    /** Rewrite one row's date columns the way earlier adapter versions stored them. */
    const makeLegacy = (userId: string): void => {
        database.prepare(`UPDATE "user" SET "createdAt" = ?, "updatedAt" = ? WHERE "id" = ?`).run(LEGACY_EXPIRY, LEGACY_EXPIRY, userId);
        database
            .prepare(`UPDATE "session" SET "expiresAt" = ?, "createdAt" = ?, "updatedAt" = ? WHERE "userId" = ?`)
            .run(LEGACY_EXPIRY, LEGACY_EXPIRY, LEGACY_EXPIRY, userId);
    };

    it("reads legacy ISO strings back as Dates", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        makeLegacy(userId);
        const { adapter } = await auth.$context;

        const session = await adapter.findOne<{ expiresAt: Date }>({ model: "session", where: [{ field: "userId", value: userId }] });

        expect(session?.expiresAt.getTime()).toBe(Date.parse(LEGACY_EXPIRY));
    });

    it("converts them so the patch and the expiry filter work, and is idempotent", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        makeLegacy(userId);
        const { adapter } = await auth.$context;
        const now = new Date();

        // Unconverted: the writer refuses the row, and SQLite sorts the string above every
        // number, so the long-expired session never matches `< now`.
        // The error names the stored column the patch did not set, and never quotes its value.
        await expect(lunoraWriter().patch("user", userId, { role: "admin" })).rejects.toThrow(
            /^user\.createdAt: expected number, received string \(a stored value this patch does not set/u,
        );
        await expect(adapter.count({ model: "session", where: [{ field: "expiresAt", operator: "lt", value: now }] })).resolves.toBe(0);

        const converted = await convertAuthDatesToEpochMs(executor, options);

        expect(converted).toStrictEqual([
            { converted: 1, table: "user" },
            { converted: 1, table: "session" },
        ]);

        const stored = database.prepare(`SELECT "expiresAt", typeof("expiresAt") AS "kind" FROM "session"`).get() as { expiresAt: number; kind: string };

        expect({ ...stored }).toStrictEqual({ expiresAt: Date.parse(LEGACY_EXPIRY), kind: "real" });

        await expect(lunoraWriter().patch("user", userId, { role: "admin" })).resolves.not.toThrow();
        await expect(adapter.count({ model: "session", where: [{ field: "expiresAt", operator: "lt", value: now }] })).resolves.toBe(1);

        await expect(convertAuthDatesToEpochMs(executor, options)).resolves.toStrictEqual([]);
    });

    it("refuses an unparseable value and converts nothing", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        makeLegacy(userId);
        database.prepare(`UPDATE "session" SET "expiresAt" = 'not a date' WHERE "userId" = ?`).run(userId);

        await expect(convertAuthDatesToEpochMs(executor, options)).rejects.toThrow(/session\.expiresAt of row .* "not a date"/u);

        expect(storageType("user", "createdAt", userId)).toBe("text");
    });

    it("converts a date-only value and refuses a malformed one made of digits and hyphens", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        makeLegacy(userId);
        database.prepare(`UPDATE "user" SET "createdAt" = '2024-01-01' WHERE "id" = ?`).run(userId);
        database.prepare(`UPDATE "session" SET "expiresAt" = '2024-13-45' WHERE "userId" = ?`).run(userId);

        await expect(convertAuthDatesToEpochMs(executor, options)).rejects.toThrow(/session\.expiresAt of row .* "2024-13-45"/u);

        database.prepare(`UPDATE "session" SET "expiresAt" = ? WHERE "userId" = ?`).run(LEGACY_EXPIRY, userId);
        await convertAuthDatesToEpochMs(executor, options);

        expect({ ...(database.prepare(`SELECT "createdAt" FROM "user" WHERE "id" = ?`).get(userId) as object) }).toStrictEqual({
            createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
        });
    });

    it("leaves a value written between the check and the update as it is, rather than erasing it", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        const userId = await signUp(auth);
        makeLegacy(userId);

        // Another writer lands a malformed value on a nullable date column after the check ran.
        const racing: SqlExecutor = {
            all: async (sql, parameters) => {
                const rows = await executor.all(sql, parameters);

                if (sql.startsWith(`SELECT (SELECT COUNT(*)`) && sql.includes(`FROM "user"`)) {
                    database.prepare(`UPDATE "user" SET "banExpires" = 'garbage' WHERE "id" = ?`).run(userId);
                }

                return rows;
            },
            run: (sql, parameters) => executor.run(sql, parameters),
        };

        await convertAuthDatesToEpochMs(racing, options);

        const row = database.prepare(`SELECT "createdAt", "banExpires" FROM "user" WHERE "id" = ?`).get(userId) as { banExpires: unknown; createdAt: unknown };

        expect({ ...row }).toStrictEqual({ banExpires: "garbage", createdAt: Date.parse(LEGACY_EXPIRY) });
    });

    it("skips an absent app-managed plugin table and converts it when present", async () => {
        expect.hasAssertions();

        const appOwned = {
            id: "app-owned",
            schema: { appGrant: { disableMigration: true, fields: { expiresAt: { required: true, type: "date" } } } },
        } as const;
        const withAppTable: LunoraAuthOptions = { ...options, plugins: [...(options.plugins ?? []), appOwned] };

        await expect(convertAuthDatesToEpochMs(executor, withAppTable)).resolves.toStrictEqual([]);

        database.exec(`CREATE TABLE "appGrant" ("id" TEXT PRIMARY KEY, "expiresAt" REAL)`);
        database.prepare(`INSERT INTO "appGrant" ("id", "expiresAt") VALUES ('g1', ?)`).run(LEGACY_EXPIRY);

        await expect(convertAuthDatesToEpochMs(executor, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);
    });
});

describe("convertAuthDatesToEpochMs — edge values", () => {
    const appOwned = {
        id: "app-owned",
        schema: { appGrant: { disableMigration: true, fields: { expiresAt: { required: true, type: "date" } } } },
    } as const;
    const withAppTable: LunoraAuthOptions = { ...options, plugins: [...(options.plugins ?? []), appOwned] };
    let consoleError: MockInstance<(...data: unknown[]) => void>;

    beforeEach(async () => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
        await runD1GlobalTableMigrations(executor, schema as never);
        // TEXT affinity, so a number is stored as its digits.
        database.exec(`CREATE TABLE "appGrant" ("id" TEXT PRIMARY KEY, "expiresAt" TEXT)`);
        // Each run reports that column; the test below asserts it, the rest only keep it quiet.
        consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("reports an app-managed date column declared with text affinity, and only that one", async () => {
        expect.hasAssertions();

        const logged = (): string[] => consoleError.mock.calls.map((call) => String(call[0]));

        await convertAuthDatesToEpochMs(executor, withAppTable);

        expect(logged()).toStrictEqual([expect.stringContaining("appGrant.expiresAt is a date column with text affinity")]);

        consoleError.mockClear();
        database.exec(`DROP TABLE "appGrant"`);
        database.exec(`CREATE TABLE "appGrant" ("id" TEXT PRIMARY KEY, "expiresAt" REAL)`);
        await convertAuthDatesToEpochMs(executor, withAppTable);

        expect(logged()).toStrictEqual([]);
    });

    it("keeps a pre-1970 epoch stored as signed digits, and reads it back as that date", async () => {
        expect.hasAssertions();

        database.prepare(`INSERT INTO "appGrant" ("id", "expiresAt") VALUES ('g1', ?)`).run(-86_400_000);

        expect(storageType("appGrant", "expiresAt", "g1")).toBe("text");
        await expect(convertAuthDatesToEpochMs(executor, withAppTable)).resolves.toStrictEqual([]);
        expect((decodeAuthDate((database.prepare(`SELECT "expiresAt" FROM "appGrant"`).get() as { expiresAt: string }).expiresAt) as Date).getTime()).toBe(
            -86_400_000,
        );
    });

    it("refuses a bare time rather than inventing a day for it", async () => {
        expect.hasAssertions();

        database.prepare(`INSERT INTO "appGrant" ("id", "expiresAt") VALUES ('g1', '12:00:00')`).run();

        await expect(convertAuthDatesToEpochMs(executor, withAppTable)).rejects.toThrow(/appGrant\.expiresAt of row g1 holds "12:00:00"/u);
    });

    describe("automatic runs", () => {
        const DAY_MS = 24 * HOUR_MS;
        const statements: string[] = [];
        const recording = (): SqlExecutor => {
            return {
                all: (sql, parameters) => {
                    statements.push(sql);

                    return executor.all(sql, parameters);
                },
                run: (sql, parameters) => executor.run(sql, parameters),
            };
        };
        /** Whether the last automatic run scanned the tables rather than stopping at its record. */
        const scanned = (): boolean => statements.some((sql) => sql.startsWith("SELECT (SELECT COUNT(*)"));
        const runAt = async (at: number, runOptions: LunoraAuthOptions = options): Promise<unknown> => {
            vi.setSystemTime(at);
            statements.length = 0;

            return convertAuthDatesOnce(recording(), runOptions);
        };
        const start = Date.parse("2026-01-01T00:00:00.000Z");

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ["Date"] });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("keep converting through the grace period, then stop at their record", async () => {
            expect.hasAssertions();

            await runAt(start, withAppTable);

            // An isolate still on the earlier version writes an ISO string during the rollout.
            database.prepare(`INSERT INTO "appGrant" ("id", "expiresAt") VALUES ('g1', '2020-01-01T00:00:00.123Z')`).run();

            await expect(runAt(start + HOUR_MS, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);

            // Another lands late in the rollout, and no cold start comes before the grace period ends.
            database.prepare(`INSERT INTO "appGrant" ("id", "expiresAt") VALUES ('g2', '2020-01-01T00:00:00.123Z')`).run();

            await expect(runAt(start + DAY_MS + HOUR_MS, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);

            await runAt(start + DAY_MS + 2 * HOUR_MS, withAppTable);

            expect(scanned()).toBe(false);

            // A plugin table with date columns changes the coverage, so the conversion runs again.
            await runAt(start + 2 * DAY_MS, options);

            expect(scanned()).toBe(true);
        });

        it("stay within a fixed query budget: one statement per table, three once skipped", async () => {
            expect.hasAssertions();

            await runAt(start, withAppTable);

            const checks = statements.filter((sql) => sql.startsWith("SELECT (SELECT COUNT(*)")).length;

            // The probe of the app-managed table, the state DDL and read, its column types, a check per table and the record write.
            expect(statements).toHaveLength(checks + 5);

            // The first run after the grace period is still a full one; the next is skipped.
            await runAt(start + DAY_MS + HOUR_MS, withAppTable);
            await runAt(start + DAY_MS + 2 * HOUR_MS, withAppTable);

            expect(statements).toHaveLength(3);
        });

        it("convert again after an import restores rows an earlier version wrote", async () => {
            expect.hasAssertions();

            await runAt(start, withAppTable);
            await runAt(start + DAY_MS + HOUR_MS, withAppTable);
            await runAt(start + DAY_MS + 2 * HOUR_MS, withAppTable);

            expect(scanned()).toBe(false);

            const port = createSqlAuthDataPort(executor, ["appGrant"]);

            await port.importRows([{ doc: { expiresAt: "2020-01-01T00:00:00.123Z", id: "g1" }, table: "appGrant" }]);

            await expect(runAt(start + 2 * DAY_MS, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);
        });

        it("never record a run clean when a restore wrote rows while it was running", async () => {
            expect.hasAssertions();

            const port = createSqlAuthDataPort(executor, ["appGrant"]);
            // The restore lands as the run is about to record itself, after it has scanned every table.
            const racing: SqlExecutor = {
                all: async (sql, parameters) => {
                    if (sql.includes(`"__lunora_auth_backfill__"`) && (sql.startsWith("UPDATE") || sql.includes("DO NOTHING"))) {
                        await port.importRows([{ doc: { expiresAt: "2020-01-01T00:00:00.123Z", id: "g1" }, table: "appGrant" }]);
                    }

                    return executor.all(sql, parameters);
                },
                run: (sql, parameters) => executor.run(sql, parameters),
            };

            vi.setSystemTime(start);
            await convertAuthDatesOnce(racing, withAppTable);

            // Past the grace period, the run still sees no clean record, so it converts the restored row.
            await expect(runAt(start + 2 * DAY_MS, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);
        });
    });

    it("reports a committed import as written when the record cannot be invalidated afterwards", async () => {
        expect.hasAssertions();

        let invalidations = 0;
        const failingLate: SqlExecutor = {
            all: async (sql, parameters) => {
                if (sql.includes(`"__lunora_auth_backfill__"`) && sql.includes("DO UPDATE")) {
                    invalidations += 1;

                    if (invalidations === 2) {
                        throw new Error("D1_ERROR: simulated");
                    }
                }

                return executor.all(sql, parameters);
            },
            run: (sql, parameters) => executor.run(sql, parameters),
        };
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        const result = await createSqlAuthDataPort(failingLate, ["appGrant"]).importRows([{ doc: { expiresAt: 1, id: "g1" }, table: "appGrant" }]);
        const logged = error.mock.calls.length;

        error.mockRestore();

        expect(result).toMatchObject({ errors: [], inserted: 1 });
        expect(logged).toBe(1);
    });

    it("invalidates the record again with a fresh token after an import, also one that stopped part-way", async () => {
        expect.hasAssertions();

        const tokens: unknown[] = [];
        const failingMidway: SqlExecutor = {
            all: async (sql, parameters) => {
                if (sql.includes(`"__lunora_auth_backfill__"`) && sql.includes("DO UPDATE")) {
                    tokens.push(parameters[1]);
                }

                if (sql === `PRAGMA table_info("user")`) {
                    throw new Error("D1_ERROR: simulated");
                }

                return executor.all(sql, parameters);
            },
            run: (sql, parameters) => executor.run(sql, parameters),
        };

        await expect(
            createSqlAuthDataPort(failingMidway, ["appGrant", "user"]).importRows([
                { doc: { expiresAt: "2020-01-01T00:00:00.123Z", id: "g1" }, table: "appGrant" },
                { doc: { id: "u1" }, table: "user" },
            ]),
        ).rejects.toThrow("simulated");

        expect(database.prepare(`SELECT "id" FROM "appGrant"`).all()).toHaveLength(1);
        expect(tokens).toHaveLength(2);
        expect(tokens[0]).not.toBe(tokens[1]);
    });

    it("finds an app-managed table whose stored name differs only in case", async () => {
        expect.hasAssertions();

        database.exec(`DROP TABLE "appGrant"`);
        database.exec(`CREATE TABLE "APPGRANT" ("id" TEXT PRIMARY KEY, "expiresAt" TEXT)`);
        database.prepare(`INSERT INTO "APPGRANT" ("id", "expiresAt") VALUES ('g1', '2020-01-01T00:00:00.123Z')`).run();

        await expect(convertAuthDatesToEpochMs(executor, withAppTable)).resolves.toStrictEqual([{ converted: 1, table: "appGrant" }]);
    });
});

describe("the auth Durable Object converts legacy dates on its cold start", () => {
    const INTERNAL_SECRET = "numeric-dates-internal-secret"; // secret-scanner:allow

    const coldStart = async (db: DatabaseSync): Promise<void> => {
        const authDo = new LunoraAuthDO({ storage: createDoStorage(db) }, () => options, { internalSecret: INTERNAL_SECRET });

        await authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));
    };

    it("rewrites ISO strings left by an earlier version as epoch ms", async () => {
        expect.hasAssertions();

        const db = new DatabaseSync(":memory:");

        // The tables as the earlier version left them, before this version's first cold start.
        for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
            db.exec(statement);
        }

        db.prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', ?, 0, ?, ?)`).run(
            EMAIL,
            "2020-01-01T00:00:00.123Z",
            "2020-01-01T00:00:00.123Z",
        );

        await coldStart(db);

        expect({ ...(db.prepare(`SELECT "createdAt" FROM "user" WHERE "id" = 'u1'`).get() as object) }).toStrictEqual({
            createdAt: Date.parse("2020-01-01T00:00:00.123Z"),
        });

        db.close();
    });
});
