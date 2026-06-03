import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it, vi } from "vitest";

import { compileMigrationsSql, ensureMigrated } from "../src/migrate.js";

vi.mock("better-auth/db/migration", () => {
    return { getMigrations: vi.fn() };
});

const mockGetMigrations = vi.mocked(getMigrations);

const makeMigrations = (runMigrations = vi.fn(async () => {})) => {
    return { compileMigrations: vi.fn(async () => "SQL"), runMigrations };
};

describe("ensureMigrated", () => {
    it("single-flights concurrent callers onto one migration run", async () => {
        expect.assertions(2);

        const runMigrations = vi.fn(async () => {});

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

        const runMigrations = vi.fn(async () => {});

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue(makeMigrations(runMigrations) as never);

        const database = {};

        await ensureMigrated({ options: { db: database } } as never);
        await ensureMigrated({ options: { db: database } } as never);

        expect(mockGetMigrations).toHaveBeenCalledTimes(2);
    });
});

describe("compileMigrationsSql", () => {
    it("forwards options to getMigrations and returns compileMigrations()'s result", async () => {
        expect.assertions(3);

        const compileMigrations = vi.fn(async () => "CREATE TABLE user (...)");

        mockGetMigrations.mockReset();
        mockGetMigrations.mockResolvedValue({ compileMigrations, runMigrations: vi.fn(async () => {}) } as never);

        const options = { db: {} };

        const sql = await compileMigrationsSql(options as never);

        expect(mockGetMigrations).toHaveBeenCalledWith(options);
        expect(compileMigrations).toHaveBeenCalledTimes(1);
        expect(sql).toBe("CREATE TABLE user (...)");
    });
});
