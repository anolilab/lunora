import { LunoraError } from "@lunora/errors";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it, vi } from "vitest";

import { compileMigrationsSql, ensureMigrated } from "../src/migrate";

vi.mock(import("better-auth/db/migration"), () => {
    return { getMigrations: vi.fn<typeof getMigrations>() };
});

const mockGetMigrations = vi.mocked(getMigrations);

const makeMigrations = (runMigrations = vi.fn<() => Promise<void>>(async () => {})) => {
    return { compileMigrations: vi.fn<() => Promise<string>>(async () => "SQL"), runMigrations };
};

/** A better-auth adapter factory — a function, which is precisely what the Kysely migrator cannot drive. */
const customAdapter = (): { id: string } => {
    return { id: "lunora" };
};

/**
 * A D1 binding stub recording every statement, with `sqlite_master` answering the
 * account table's DDL. `batch` exists only so `isD1Database` recognises the shape.
 */
const fakeD1 = (accountDdl: null | string) => {
    const statements: string[] = [];

    const first = async (): Promise<{ sql: null | string } | null> => (accountDdl === null ? null : { sql: accountDdl });

    return {
        // Never called — it exists only because `isD1Database` checks for it.
        batch: (): void => {},
        prepare: (query: string) => {
            statements.push(query);

            return {
                bind: () => {
                    return { first };
                },
                run: async (): Promise<void> => {},
            };
        },
        statements,
    };
};

const LEGACY_ACCOUNT_DDL = `CREATE TABLE "account" ("id" text NOT NULL, "issuer" text NOT NULL, "accountId" text NOT NULL)`;

describe("ensureMigrated", () => {
    it("single-flights concurrent callers onto one migration run", async () => {
        expect.assertions(2);

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const options = { database: { db: {} } };

        await Promise.all([ensureMigrated({ options }), ensureMigrated({ options })]);

        expect(mockGetMigrations).toHaveBeenCalledTimes(1);
        expect(runMigrations).toHaveBeenCalledTimes(1);
    });

    it("evicts the cached run on failure so the next call retries", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockRejectedValueOnce(new Error("boom"));
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { database: { db: {} } };

        await expect(ensureMigrated({ options })).rejects.toThrow("boom");

        await ensureMigrated({ options });

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });

    it("does NOT share the single-flight cache across distinct options objects", async () => {
        // The WeakMap is keyed by the `options` reference, so two distinct
        // option objects — even targeting the same DB — each launch their own
        // run. This pins the current (documented) behaviour so a caller that
        // builds `createAuth({...})` per request knows the diff re-runs.
        expect.assertions(1);

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const database = {};

        await ensureMigrated({ options: { database: { db: database } } });
        await ensureMigrated({ options: { database: { db: database } } });

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });

    it("throws — and never reaches better-auth's migrator — for a custom adapter", async () => {
        // better-auth's own guard for a non-kysely `database` calls
        // `process.exit(1)`, which in a Workers isolate kills every route after a
        // single 500. Reject before handing it over.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { database: customAdapter };

        await expect(ensureMigrated({ options })).rejects.toThrow(/custom adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("throws for an absent `database`, which exits the isolate exactly like an adapter does", async () => {
        // `createKyselyAdapter` answers `{ kysely: null }` for ANY unrecognised
        // `database`, not only functions — an absent one included — and
        // `getMigrations` process.exits on that. Verified against better-auth
        // 1.7.1: `getMigrations({ database: undefined })` kills the process.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(ensureMigrated({ options: {} })).rejects.toThrow(/no `database`/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("drops the reverted `account.issuer` column on a D1 database that still has it", async () => {
        // better-auth 1.7.0 required this column and 1.7.3 reverted it, and upstream's
        // migrator does not remove it — so without this step `runMigrations()` reports
        // success and every later sign-up dies on `NOT NULL constraint failed`.
        expect.assertions(3);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(LEGACY_ACCOUNT_DDL);

        await ensureMigrated({ options: { database } });

        // Read through `sqlite_master`, never `pragma_table_info` — D1's authorizer
        // refuses pragma table-valued functions through the Worker binding.
        expect(database.statements[0]).toMatch(/sqlite_master/u);
        expect(database.statements).toContain(`DROP INDEX IF EXISTS "account_issuer_accountId_uidx"`);
        expect(database.statements).toContain(`ALTER TABLE "account" DROP COLUMN "issuer"`);
    });

    it("issues no DDL when the account table never had the column", async () => {
        expect.assertions(1);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(`CREATE TABLE "account" ("id" text NOT NULL, "accountId" text NOT NULL)`);

        await ensureMigrated({ options: { database } });

        expect(database.statements.filter((statement) => /DROP|ALTER/u.test(statement))).toStrictEqual([]);
    });

    it("issues no DDL when the account table does not exist yet", async () => {
        // A first-ever migration: better-auth just created the table without `issuer`,
        // and `sqlite_master` returning no row must not be read as "drop it".
        expect.assertions(1);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const database = fakeD1(null);

        await ensureMigrated({ options: { database } });

        expect(database.statements.filter((statement) => /DROP|ALTER/u.test(statement))).toStrictEqual([]);
    });

    it("leaves a non-D1 database alone, since the remedy there is to relax the constraint", async () => {
        // Postgres/MySQL keep the column and drop only the NOT NULL; dropping it is the
        // SQLite-specific answer, and D1 is the only SQLite `database` shape here.
        expect.assertions(1);

        mockGetMigrations.mockReset();

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        await ensureMigrated({ options: { database: { db: {} } } });

        expect(runMigrations).toHaveBeenCalledTimes(1);
    });

    it("carries a non-internal code, so the guidance survives the wire", async () => {
        // `INTERNAL` is `internal: true`, and `toErrorBody` replaces an internal
        // code's message with "Internal error". This error exists only to tell a
        // developer what to do instead, so redacting it defeats the guard.
        expect.assertions(2);

        mockGetMigrations.mockReset();

        const error = await ensureMigrated({ options: { database: customAdapter } }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).code).toBe("AUTH_MIGRATOR_UNSUPPORTED");
    });
});

describe("compileMigrationsSql", () => {
    it("throws for a custom adapter instead of exiting the isolate", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(compileMigrationsSql({ database: customAdapter })).rejects.toThrow(/custom adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("throws for an absent `database` rather than exiting the isolate", async () => {
        // The published recipe for this used to be `database: undefined`
        // ("schema-only, no live DB"), which has never worked — better-auth needs
        // a Kysely-drivable database to introspect against.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(compileMigrationsSql({})).rejects.toThrow(/no `database`/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("compiles from the resolved options (so the rateLimit table is included) and returns compileMigrations()'s result", async () => {
        expect.assertions(3);

        const compileMigrations = vi.fn<() => Promise<string>>(async () => "CREATE TABLE user (...)");

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue({ compileMigrations, runMigrations: vi.fn<() => Promise<void>>(async () => {}) } as never);

        const options = { database: { db: {} } };

        const sql = await compileMigrationsSql(options);

        // Routed through `resolveAuthOptions`, so migrations are compiled from the
        // SAME resolved shape the worker runs with — the default-on durable rate
        // limiter's `rateLimit` table is therefore present in the migration.
        expect(mockGetMigrations).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: expect.objectContaining({ enabled: true, storage: "database" }) }));
        expect(compileMigrations).toHaveBeenCalledTimes(1);
        expect(sql).toBe("CREATE TABLE user (...)");
    });
});
