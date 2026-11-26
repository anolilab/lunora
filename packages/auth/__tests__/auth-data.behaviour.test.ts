import { DatabaseSync } from "node:sqlite";

import { createSchemaCheck, getAuthTablesWithResolvedIndexes } from "@better-auth/core/db/internal";
import { runD1GlobalTableMigrations } from "@lunora/d1";
import type { TableDefinition } from "@lunora/server";
import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { convertAuthDatesOnce as exportedConvertAuthDatesOnce, prepareAuthData as exportedPrepareAuthData } from "../src";
import { lunoraD1Adapter } from "../src/adapter";
import { prepareAuthData } from "../src/auth-data";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { convertAuthDatesOnce } from "../src/dates";
import { inviteOnly } from "../src/invite-only";
import { admin } from "../src/plugins";
import authTables from "../src/schema";
import type { SqlExecutor } from "../src/sql-store";
import { d1Executor } from "../src/sql-store";

vi.mock(import("@better-auth/core/db/internal"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, getAuthTablesWithResolvedIndexes: vi.fn<typeof actual.getAuthTablesWithResolvedIndexes>(actual.getAuthTablesWithResolvedIndexes) };
});

/**
 * An app that declares the auth tables `.global()` in its Lunora schema and serves better-auth
 * through `lunoraD1Adapter` from its own Worker entry: no better-auth migrator anywhere.
 */

const options: LunoraAuthOptions = {
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    plugins: [admin()],
    secret: "lunora-auth-data-secret-lunora-auth-data-secret",
};

// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow
const LEGACY_DATE = "2020-01-01T00:00:00.123Z";

const schema = defineSchema(
    Object.fromEntries(
        Object.entries(authTables(resolveAuthOptions(options))).map(([name, table]) => [
            name,
            (table as unknown as { global: () => TableDefinition }).global(),
        ]),
    ),
);

/** A D1 binding over a real `node:sqlite` database: statements execute, so a missing table fails as it does on D1. */
const fakeD1 = (database: DatabaseSync) => {
    const statement = (query: string, values: unknown[] = []) => {
        return {
            all: async (): Promise<{ results: Record<string, unknown>[] }> => {
                return { results: database.prepare(query).all(...(values as never[])) };
            },
            bind: (...bound: unknown[]) => statement(query, bound),
            query,
            run: async (): Promise<void> => {
                database.prepare(query).run(...(values as never[]));
            },
            values,
        };
    };

    return {
        batch: async (statements: { query: string; values: unknown[] }[]): Promise<void> => {
            database.exec("BEGIN");

            try {
                for (const { query, values } of statements) {
                    database.prepare(query).run(...(values as never[]));
                }

                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }
        },
        prepare: (query: string) => statement(query),
    };
};

const provisionSchema = async (executor: SqlExecutor): Promise<void> => runD1GlobalTableMigrations(executor, schema as never);

let database: DatabaseSync;
let d1: ReturnType<typeof fakeD1>;

const buildAuth = (provision?: (executor: SqlExecutor) => Promise<void>): LunoraAuth =>
    createAuth({
        ...options,
        database: lunoraD1Adapter(d1, provision === undefined ? {} : { provision }),
        session: { cookieCache: { enabled: false } },
    });

const signUp = async (auth: LunoraAuth, email: string): Promise<string> => {
    const { user } = await auth.api.signUpEmail({ body: { email, name: "Ada", password: PASSWORD } });

    return user.id;
};

describe("lunoraD1Adapter — provisioning `.global()` auth tables", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        d1 = fakeD1(database);
        // The schema check reports the missing tables before provisioning is asked for.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("fails the first auth statement on a fresh database without it", async () => {
        expect.hasAssertions();

        await expect(signUp(buildAuth(), "ada@example.com")).rejects.toThrow(/no such table|rateLimit|user/iu);
    });

    it("creates the tables before the first statement, once per binding however many instances are built", async () => {
        expect.hasAssertions();

        const provision = vi.fn<(executor: SqlExecutor) => Promise<void>>(provisionSchema);

        await expect(signUp(buildAuth(provision), "ada@example.com")).resolves.toEqual(expect.any(String));
        // A per-request `createAuth` over the same binding shares the run.
        await expect(signUp(buildAuth(provision), "grace@example.com")).resolves.toEqual(expect.any(String));

        expect(provision).toHaveBeenCalledTimes(1);
    });

    it("re-takes a missing-table verdict cached before provisioning created the tables", async () => {
        expect.hasAssertions();

        const unprovisioned = buildAuth();

        await expect(signUp(unprovisioned, "ada@example.com")).rejects.toThrow(/no such table|rateLimit|user/iu);

        await signUp(buildAuth(provisionSchema), "grace@example.com");

        await expect(signUp(unprovisioned, "ada@example.com")).resolves.toEqual(expect.any(String));
    });

    it("retries a failed provisioning on the next statement instead of keeping the failure", async () => {
        expect.hasAssertions();

        const provision = vi
            .fn<(executor: SqlExecutor) => Promise<void>>()
            .mockRejectedValueOnce(new Error("D1 unavailable"))
            .mockImplementation(provisionSchema);
        const auth = buildAuth(provision);

        await expect(signUp(auth, "ada@example.com")).rejects.toThrow("D1 unavailable");
        await expect(signUp(auth, "ada@example.com")).resolves.toEqual(expect.any(String));
        expect(provision).toHaveBeenCalledTimes(2);
    });
});

describe("prepareAuthData — the data steps without better-auth's migrator", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        d1 = fakeD1(database);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        database.close();
    });

    it("is exported with the marker-based date conversion from the package entry", () => {
        expect.hasAssertions();
        expect(exportedPrepareAuthData).toBe(prepareAuthData);
        expect(exportedConvertAuthDatesOnce).toBe(convertAuthDatesOnce);
    });

    it("provisions, then converts ISO dates and fills the canonical email, once per isolate", async () => {
        expect.hasAssertions();

        const runOptions = { ...options };
        const auth = buildAuth(provisionSchema);
        const userId = await signUp(auth, "ada@example.com");

        database.prepare(`UPDATE "user" SET "createdAt" = ?, "emailCanonical" = NULL WHERE "id" = ?`).run(LEGACY_DATE, userId);

        await prepareAuthData(d1Executor(d1), runOptions, { provision: provisionSchema });

        const row = database.prepare(`SELECT "createdAt", "emailCanonical" FROM "user" WHERE "id" = ?`).get(userId) as Record<string, unknown>;

        expect({ ...row }).toStrictEqual({ createdAt: Date.parse(LEGACY_DATE), emailCanonical: "ada@example.com" });

        // The conversion is per isolate: a second call with the same options does not scan again.
        database.prepare(`UPDATE "user" SET "createdAt" = ? WHERE "id" = ?`).run(LEGACY_DATE, userId);
        await prepareAuthData(d1Executor(d1), runOptions);

        expect((database.prepare(`SELECT "createdAt" FROM "user" WHERE "id" = ?`).get(userId) as { createdAt: unknown }).createdAt).toBe(LEGACY_DATE);
    });

    it("drops the reverted `account.issuer` column and its index through the executor", async () => {
        expect.hasAssertions();

        await provisionSchema(d1Executor(d1));
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);
        database.exec(`CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")`);

        await prepareAuthData(d1Executor(d1), { ...options }, { schema });

        const columns = database
            .prepare(`SELECT name FROM pragma_table_info('account')`)
            .all()
            .map((column) => String((column as { name: unknown }).name));

        expect(columns).not.toContain("issuer");
        expect(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'account_issuer_accountId_uidx'`).get()).toBeUndefined();
    });

    it("re-takes the adapter's schema verdict after the drop, and only once", async () => {
        expect.hasAssertions();

        await provisionSchema(d1Executor(d1));
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

        const find = vi.fn<() => Promise<[]>>(async () => []);
        const check = createSchemaCheck(find, "database", d1);
        const runOptions = { ...options };

        await check();
        await prepareAuthData(d1Executor(d1), runOptions, { schema });
        await check();
        await prepareAuthData(d1Executor(d1), runOptions, { schema });
        await check();

        expect(find).toHaveBeenCalledTimes(2);
    });

    it("prepares each database that shares one options object", async () => {
        expect.hasAssertions();

        const other = new DatabaseSync(":memory:");
        const otherD1 = fakeD1(other);
        const runOptions = { ...options };

        try {
            await Promise.all([provisionSchema(d1Executor(d1)), provisionSchema(d1Executor(otherD1))]);

            other.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

            await prepareAuthData(d1Executor(d1), runOptions, { schema });
            await prepareAuthData(d1Executor(otherD1), runOptions, { schema });

            expect(other.prepare(`SELECT name FROM pragma_table_info('account') WHERE name = 'issuer'`).get()).toBeUndefined();
        } finally {
            other.close();
        }
    });

    it("retries an issuer cleanup that threw instead of keeping the failure", async () => {
        expect.hasAssertions();

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const executor = d1Executor(d1);

        await provisionSchema(executor);
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

        const runOptions = { ...options };

        vi.mocked(getAuthTablesWithResolvedIndexes).mockImplementationOnce(() => {
            throw new Error("schema unreadable");
        });

        await expect(prepareAuthData(executor, runOptions, { schema })).resolves.toBeUndefined();

        await prepareAuthData(executor, runOptions, { schema });

        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("the next call retries it"), expect.any(Error));
        expect(database.prepare(`SELECT name FROM pragma_table_info('account') WHERE name = 'issuer'`).get()).toBeUndefined();
    });

    it("logs and leaves the column when the executor cannot drop it atomically", async () => {
        expect.hasAssertions();

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const executor = d1Executor(d1);

        await provisionSchema(executor);
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

        await prepareAuthData({ all: executor.all, run: executor.run }, { ...options }, { schema });

        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("has no `batch`"));
        expect(database.prepare(`SELECT "issuer" FROM "account" LIMIT 0`).all()).toStrictEqual([]);
    });

    it("keeps an `account.issuer` column the app's schema declares, with or without `batch`", async () => {
        expect.hasAssertions();

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const { shape } = authTables(resolveAuthOptions(options))["account"] as TableDefinition;
        const account = defineTable({ ...shape, issuer: v.optional(v.string()) }) as unknown as { global: () => TableDefinition };
        const appSchema = defineSchema({ ...schema.tables, account: account.global() });
        const executor = d1Executor(d1);

        await provisionSchema(executor);
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text`);

        await prepareAuthData(executor, { ...options }, { schema: appSchema });
        await prepareAuthData({ all: executor.all, run: executor.run }, { ...options }, { schema: appSchema });

        expect(database.prepare(`SELECT "issuer" FROM "account" LIMIT 0`).all()).toStrictEqual([]);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("reports an undeclared `account.issuer` column instead of dropping it when no schema is passed", async () => {
        expect.hasAssertions();

        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const executor = d1Executor(d1);

        await provisionSchema(executor);
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

        await prepareAuthData(executor, { ...options });

        expect(database.prepare(`SELECT "issuer" FROM "account" LIMIT 0`).all()).toStrictEqual([]);
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("legacyIssuerCleanupStatements()"));
    });

    it("reports rather than drops when the schema passed does not declare the account table", async () => {
        expect.hasAssertions();

        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const executor = d1Executor(d1);
        const withoutAccount = Object.fromEntries(Object.entries(schema.tables).filter(([name]) => name !== "account"));

        await provisionSchema(executor);
        database.exec(`ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT ''`);

        await prepareAuthData(executor, { ...options }, { schema: defineSchema(withoutAccount) });

        expect(database.prepare(`SELECT "issuer" FROM "account" LIMIT 0`).all()).toStrictEqual([]);
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(`declares the "account" table`));
    });

    it("skips the invitation-email backfill alone, leaving the canonical-email backfill running", async () => {
        expect.hasAssertions();

        const inviteOptions: LunoraAuthOptions = { ...options, plugins: [admin(), inviteOnly()] };
        const inviteSchema = defineSchema(
            Object.fromEntries(
                Object.entries(authTables(resolveAuthOptions(inviteOptions))).map(([name, table]) => [
                    name,
                    (table as unknown as { global: () => TableDefinition }).global(),
                ]),
            ),
        );
        const executor = d1Executor(d1);
        const insertUser = `INSERT INTO "user" ("_creationTime", "id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (0, ?, 'Ada', ?, 0, 0, 0)`;
        const insertInvitation = `INSERT INTO "signUpInvitation" ("_creationTime", "id", "email", "createdAt", "expiresAt") VALUES (0, ?, ?, 0, 0)`;

        await runD1GlobalTableMigrations(executor, inviteSchema as never);
        database.prepare(insertUser).run("u1", "Ada@Example.com");
        database.prepare(insertInvitation).run("i1", "Grace@Example.com");

        await prepareAuthData(executor, { ...inviteOptions }, { invitationEmailBackfill: false });

        expect({ ...database.prepare(`SELECT "emailCanonical" FROM "user"`).get() }).toStrictEqual({ emailCanonical: "ada@example.com" });
        expect({ ...database.prepare(`SELECT "email" FROM "signUpInvitation"`).get() }).toStrictEqual({ email: "Grace@Example.com" });
    });

    it("skips the canonical-email and invitation-email backfills on request and still converts dates", async () => {
        expect.hasAssertions();

        const runOptions = { ...options };
        const userId = await signUp(buildAuth(provisionSchema), "ada@example.com");

        database.prepare(`UPDATE "user" SET "createdAt" = ?, "emailCanonical" = NULL WHERE "id" = ?`).run(LEGACY_DATE, userId);

        await prepareAuthData(d1Executor(d1), runOptions, { canonicalEmailBackfill: false, invitationEmailBackfill: false });

        const row = database.prepare(`SELECT "createdAt", "emailCanonical" FROM "user" WHERE "id" = ?`).get(userId) as Record<string, unknown>;

        expect({ ...row }).toStrictEqual({ createdAt: Date.parse(LEGACY_DATE), emailCanonical: null });

        // A skipped backfill is not marked done: a later call that enables it still fills the row.
        await prepareAuthData(d1Executor(d1), runOptions);

        expect((database.prepare(`SELECT "emailCanonical" FROM "user" WHERE "id" = ?`).get(userId) as { emailCanonical: unknown }).emailCanonical).toBe(
            "ada@example.com",
        );
    });
});
