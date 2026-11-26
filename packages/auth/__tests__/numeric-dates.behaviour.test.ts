import { DatabaseSync } from "node:sqlite";

import { createD1CtxDb, runD1GlobalTableMigrations } from "@lunora/d1";
import type { TableDefinition } from "@lunora/server";
import { defineSchema } from "@lunora/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, RESOLVE_SESSION_PATH } from "../src/auth-do";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { convertAuthDatesToEpochMs } from "../src/dates";
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
        await expect(lunoraWriter().patch("user", userId, { role: "admin" })).rejects.toThrow(/expected number/iu);
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
            all: (sql, parameters) => {
                if (sql.startsWith(`SELECT COUNT(*)`) && sql.includes(`FROM "user"`)) {
                    database.prepare(`UPDATE "user" SET "banExpires" = 'garbage' WHERE "id" = ?`).run(userId);
                }

                return executor.all(sql, parameters);
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

describe("the auth Durable Object converts legacy dates on its cold start", () => {
    const INTERNAL_SECRET = "numeric-dates-internal-secret"; // secret-scanner:allow

    const coldStart = async (db: DatabaseSync): Promise<void> => {
        const authDo = new LunoraAuthDO({ storage: createDoStorage(db) }, () => options, { internalSecret: INTERNAL_SECRET });

        await authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } }));
    };

    it("rewrites ISO strings left by an earlier version as epoch ms", async () => {
        expect.hasAssertions();

        const db = new DatabaseSync(":memory:");

        await coldStart(db);
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
