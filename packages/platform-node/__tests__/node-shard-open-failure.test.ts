import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeShardRegistry } from "../src/node-shard-registry";

// Every connection the code under test opens, so a test can check none is left open after a failed shard open, and a switch
// that makes the first write-mode setup step (the WAL pragma) throw on a database that opened fine.
const recording = vi.hoisted(() => {
    return { failSetup: false, opened: [] as BetterSqlite3.Database[] };
});

vi.mock(import("better-sqlite3"), async (importOriginal) => {
    const actual = await importOriginal();
    const Real = actual.default;

    class Recording extends Real {
        public constructor(...args: ConstructorParameters<typeof Real>) {
            super(...args);
            recording.opened.push(this);
        }

        public override pragma(source: string, options?: BetterSqlite3.PragmaOptions): unknown {
            if (recording.failSetup && source.startsWith("journal_mode")) {
                throw new Error("forced setup failure");
            }

            return super.pragma(source, options);
        }
    }

    return { ...actual, default: Recording as typeof Real };
});

describe("opening a shard that fails after its database opened", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-shard-open-failure-"));
        recording.opened.length = 0;
        recording.failSetup = false;
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("closes the database when shardFor fails during setup", () => {
        expect.assertions(3);

        // A shard file that exists, made by a first registry; the second opens it, and its setup then throws.
        const first = createNodeShardRegistry({ directory });

        first.shardFor("tenant-a");
        first.close();
        recording.opened.length = 0;
        recording.failSetup = true;

        const second = createNodeShardRegistry({ directory });

        try {
            expect(() => second.shardFor("tenant-a")).toThrow(/forced setup failure/u);
            expect(recording.opened.length).toBeGreaterThan(0);
            expect(recording.opened.filter((database) => database.open)).toStrictEqual([]);
        } finally {
            second.close();
        }
    });

    it("closes the database when re-arming a persisted alarm cannot open its shard", async () => {
        expect.assertions(2);

        const first = createNodeShardRegistry({ directory });

        await first.shardFor("tenant-a").shard.alarms.set(Date.now() + 60_000);
        first.close();
        recording.opened.length = 0;
        recording.failSetup = true;

        const second = createNodeShardRegistry({ directory });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            // One unreadable shard fails only itself: nothing is re-armed, and its handle is not kept.
            expect(second.rearmPersistedAlarms()).toStrictEqual([]);
            expect(recording.opened.filter((database) => database.open)).toStrictEqual([]);
        } finally {
            consoleError.mockRestore();
            second.close();
        }
    });
});
