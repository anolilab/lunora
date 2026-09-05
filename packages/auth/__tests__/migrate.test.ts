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

describe("ensureMigrated", () => {
    it("single-flights concurrent callers onto one migration run", async () => {
        expect.assertions(2);

        const runMigrations = vi.fn<() => Promise<void>>(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const options = { db: {} };

        await Promise.all([ensureMigrated({ options } as never), ensureMigrated({ options } as never)]);

        expect(mockGetMigrations).toHaveBeenCalledTimes(1);
        expect(runMigrations).toHaveBeenCalledTimes(1);
    });

    it("evicts the cached run on failure so the next call retries", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockRejectedValueOnce(new Error("boom"));
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { db: {} };

        await expect(ensureMigrated({ options } as never)).rejects.toThrow("boom");

        await ensureMigrated({ options } as never);

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

        await ensureMigrated({ options: { db: database } } as never);
        await ensureMigrated({ options: { db: database } } as never);

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });

    it("throws — and never reaches better-auth's migrator — for a custom adapter", async () => {
        // better-auth's own guard for a non-kysely `database` calls
        // `process.exit(1)`, which in a Workers isolate kills every route after a
        // single 500. Reject before handing it over, with a message naming a
        // provisioning path that does work.
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        const options = { database: customAdapter };

        await expect(ensureMigrated({ options })).rejects.toThrow(/only migrate through its Kysely adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });
});

describe("compileMigrationsSql", () => {
    it("throws for a custom adapter instead of exiting the isolate", async () => {
        expect.assertions(2);

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations() as never);

        await expect(compileMigrationsSql({ database: customAdapter })).rejects.toThrow(/only migrate through its Kysely adapter/u);

        expect(mockGetMigrations).not.toHaveBeenCalled();
    });

    it("compiles from the resolved options (so the rateLimit table is included) and returns compileMigrations()'s result", async () => {
        expect.assertions(3);

        const compileMigrations = vi.fn<() => Promise<string>>(async () => "CREATE TABLE user (...)");

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue({ compileMigrations, runMigrations: vi.fn<() => Promise<void>>(async () => {}) } as never);

        const options = { db: {} };

        const sql = await compileMigrationsSql(options as never);

        // Routed through `resolveAuthOptions`, so migrations are compiled from the
        // SAME resolved shape the worker runs with — the default-on durable rate
        // limiter's `rateLimit` table is therefore present in the migration.
        expect(mockGetMigrations).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: expect.objectContaining({ enabled: true, storage: "database" }) }));
        expect(compileMigrations).toHaveBeenCalledTimes(1);
        expect(sql).toBe("CREATE TABLE user (...)");
    });
});
