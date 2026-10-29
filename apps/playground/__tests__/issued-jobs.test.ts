import { DatabaseSync } from "node:sqlite";

import type { D1DatabaseLike } from "@lunora/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/test/job-status` must recognise an id `/test/schedule` issued even when the
 * two requests do not share in-process state.
 *
 * Cloudflare does not guarantee that two requests reach the same Worker isolate,
 * so a record kept in module scope is written by one route and invisible to the
 * other. `LUNORA_E2E_EXTERNAL` makes that reachable rather than theoretical: it
 * points the suite at a playground someone else started, up to and including a
 * deployed preview, where several isolates are ordinary.
 *
 * The split is simulated with `vi.resetModules()` — two module registries, so
 * nothing in-process is shared — while handing both copies the SAME database.
 * That is exactly the asymmetry of two isolates behind one binding.
 *
 * `node:sqlite` stands in for the binding. It is NOT workerd's SQLite (it builds
 * with `SQLITE_DQS=0`, so quoting mistakes behave differently there), and is not
 * evidence about dialect — only a store that outlives a module registry. The
 * statements run against real D1 in the e2e suite.
 */

/** The subset of a prepared statement this double implements, without the generics the real type carries. */
interface FakeStatement {
    all: () => Promise<{ results: unknown[]; success: boolean }>;
    bind: (...values: unknown[]) => FakeStatement;
    first: () => Promise<unknown>;
    raw: () => Promise<unknown[][]>;
    run: () => Promise<{ success: boolean }>;
}

const openDatabase = (): { close: () => void; database: D1DatabaseLike } => {
    const sqlite = new DatabaseSync(":memory:");

    const prepare = (sql: string): FakeStatement => {
        const bound: unknown[] = [];

        const statement: FakeStatement = {
            all: async () => {
                return { results: sqlite.prepare(sql).all(...(bound as never[])), success: true };
            },
            bind: (...values: unknown[]) => {
                bound.push(...values);

                return statement;
            },
            first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
            raw: async () => [],
            run: async () => {
                sqlite.prepare(sql).run(...(bound as never[]));

                return { success: true };
            },
        };

        return statement;
    };

    return {
        close: () => {
            sqlite.close();
        },
        database: { prepare } as unknown as D1DatabaseLike,
    };
};

/** A fresh module registry — the stand-in for a second Worker isolate. */
const loadIsolate = async (): Promise<typeof import("../src/server/issued-jobs")> => {
    vi.resetModules();

    return import("../src/server/issued-jobs");
};

describe("issued-job record", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("recognises an id across isolates that share only the database", async () => {
        expect.assertions(2);

        const { close, database } = openDatabase();

        try {
            const writer = await loadIsolate();

            await writer.rememberIssuedJob(database, "job-abc");

            // Same binding, different module registry: what a second isolate sees.
            const reader = await loadIsolate();

            await expect(reader.wasJobIssued(database, "job-abc")).resolves.toBe(true);
            await expect(reader.wasJobIssued(database, "job-never-scheduled")).resolves.toBe(false);
        } finally {
            close();
        }
    });

    it("reports an id nothing issued as not issued, on a database that has never scheduled", async () => {
        expect.assertions(1);

        const { close, database } = openDatabase();

        try {
            const reader = await loadIsolate();

            await expect(reader.wasJobIssued(database, "job-typo")).resolves.toBe(false);
        } finally {
            close();
        }
    });
});
