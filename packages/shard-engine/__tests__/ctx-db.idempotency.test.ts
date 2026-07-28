import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDEMPOTENCY_TABLE, readIdempotent, runShardMigrations, trimIdempotent, writeIdempotent } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Mutation-replay dedup table, driven through a real SQLite engine. The
 * `__idempotency` table is created unconditionally by `runShardMigrations` and
 * keyed by `(identity, mutation_id)`: a replayed mutation under the same identity
 * resolves to its cached result instead of re-executing. These helpers back the
 * exactly-once short-circuit on the shard dispatch path.
 */

let harness: ReturnType<typeof createSqliteExec>;

const tableExists = (name: string): boolean => harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

describe("ctx-db mutation idempotency", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema);
    });

    afterEach(() => {
        harness.close();
    });

    it("creates the dedup table on every shard, independent of CDC", () => {
        expect.assertions(1);

        expect(tableExists(IDEMPOTENCY_TABLE)).toBe(true);
    });

    it("returns undefined for a mutation id it has never seen", () => {
        expect.assertions(1);

        expect(readIdempotent(harness.sql, "u1", "m-unknown")).toBeUndefined();
    });

    it("round-trips a committed result keyed by identity + mutation id", () => {
        expect.assertions(2);

        writeIdempotent(harness.sql, "u1", "m-1", JSON.stringify({ ok: true }), 1_700_000_000_000);

        const record = readIdempotent(harness.sql, "u1", "m-1");

        expect(record?.resultJson).toBe(JSON.stringify({ ok: true }));
        expect(record?.ts).toBe(1_700_000_000_000);
    });

    it("keeps the first result on a re-write of the same key (INSERT OR IGNORE)", () => {
        expect.assertions(1);

        writeIdempotent(harness.sql, "u1", "m-1", JSON.stringify("first"), 1_700_000_000_000);
        // A re-entrant replay must not clobber the original cached result.
        writeIdempotent(harness.sql, "u1", "m-1", JSON.stringify("second"), 1_700_000_000_500);

        expect(readIdempotent(harness.sql, "u1", "m-1")?.resultJson).toBe(JSON.stringify("first"));
    });

    it("namespaces by identity — the same mutation id under a different user is a distinct record", () => {
        expect.assertions(3);

        writeIdempotent(harness.sql, "u1", "m-shared", JSON.stringify("a"), 1_700_000_000_000);
        writeIdempotent(harness.sql, "u2", "m-shared", JSON.stringify("b"), 1_700_000_000_000);

        expect(readIdempotent(harness.sql, "u1", "m-shared")?.resultJson).toBe(JSON.stringify("a"));
        expect(readIdempotent(harness.sql, "u2", "m-shared")?.resultJson).toBe(JSON.stringify("b"));
        // The empty-identity namespace (anonymous callers) is its own bucket.
        expect(readIdempotent(harness.sql, "", "m-shared")).toBeUndefined();
    });

    it("trims records older than the cutoff and keeps newer ones", () => {
        expect.assertions(2);

        writeIdempotent(harness.sql, "u1", "old", JSON.stringify(1), 1000);
        writeIdempotent(harness.sql, "u1", "new", JSON.stringify(2), 5000);

        trimIdempotent(harness.sql, 4000);

        expect(readIdempotent(harness.sql, "u1", "old")).toBeUndefined();
        expect(readIdempotent(harness.sql, "u1", "new")?.resultJson).toBe(JSON.stringify(2));
    });
});
