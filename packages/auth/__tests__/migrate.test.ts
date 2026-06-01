import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it, vi } from "vitest";

import { ensureMigrated } from "../src/migrate.js";

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
});
