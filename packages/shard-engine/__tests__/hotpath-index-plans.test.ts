import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { minCdcReplayableSeq, runShardMigrations } from "../src/ctx-db";
import { nextTtlExpiry, selectExpiredIds } from "../src/ttl-sweep";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The query plans of two alarm/replica hot paths, taken from the SQL the
 * production functions actually emit (recorded off the `SqlExec`), so the test
 * fails if the query and its index ever stop matching textually.
 */

const schema = {
    tables: {
        otps: {
            indexes: [],
            shape: { deletedAt: { kind: "number" }, expiresAt: { kind: "number" } },
            softDeleteMode: { field: "deletedAt" },
            ttlPolicy: { field: "expiresAt" },
        },
        sessions: {
            indexes: [],
            shape: { expiresAt: { kind: "number" } },
            ttlPolicy: { field: "expiresAt" },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;

/** Run `call` against a recording `SqlExec` and return the plan of every statement it issued. */
const plansOf = (call: (sql: SqlExec) => unknown): string[] => {
    const issued: { params: unknown[]; query: string }[] = [];
    const recording: SqlExec = {
        exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => {
            issued.push({ params, query });

            return harness.sql.exec<Row>(query, ...params);
        },
    };

    call(recording);

    return issued.map(({ params, query }) =>
        harness
            .raw(`EXPLAIN QUERY PLAN ${query}`, ...params)
            .map((step) => String(step["detail"]))
            .join(" | "),
    );
};

describe("hot-path index plans", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("answers the ttl sweep and its earliest-expiry probe from the ttl index", () => {
        expect.assertions(4);

        runShardMigrations(harness.sql, schema);

        const sweep = plansOf((sql) => selectExpiredIds(sql, { field: "expiresAt", table: "sessions" }, 1000, 10));
        const earliest = plansOf((sql) => nextTtlExpiry(sql, { field: "expiresAt", table: "sessions" }));
        const softSweep = plansOf((sql) => selectExpiredIds(sql, { field: "expiresAt", softDeleteField: "deletedAt", table: "otps" }, 1000, 10));
        const softEarliest = plansOf((sql) => nextTtlExpiry(sql, { field: "expiresAt", softDeleteField: "deletedAt", table: "otps" }));

        expect(sweep.join(",")).toContain("SEARCH sessions USING INDEX sessions__ttl");
        expect(earliest.join(",")).toContain("SEARCH sessions USING COVERING INDEX sessions__ttl");
        expect(softSweep.join(",")).toContain("SEARCH otps USING INDEX otps__ttl");
        expect(softEarliest.join(",")).toContain("SEARCH otps USING COVERING INDEX otps__ttl");
    });

    it("reports the earliest live expiry, with the after offset, and nothing for an empty table", () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, schema);

        expect(nextTtlExpiry(harness.sql, { field: "expiresAt", table: "sessions" })).toBeUndefined();

        harness.raw(`INSERT INTO sessions (id, _creationTime, __doc__) VALUES ('a', 1, '{"expiresAt":500}'), ('b', 1, '{"expiresAt":200}'), ('c', 1, '{}')`);
        harness.raw(`INSERT INTO otps (id, _creationTime, __doc__) VALUES ('a', 1, '{"expiresAt":100,"deletedAt":5}'), ('b', 1, '{"expiresAt":300}')`);

        expect(nextTtlExpiry(harness.sql, { after: 50, field: "expiresAt", table: "sessions" })).toBe(250);
        // The tombstone's earlier expiry is not live, so it does not count.
        expect(nextTtlExpiry(harness.sql, { field: "expiresAt", softDeleteField: "deletedAt", table: "otps" })).toBe(300);
    });

    it("answers the cdc payload floor from the partial index", () => {
        expect.assertions(1);

        runShardMigrations(harness.sql, schema, { cdc: true });

        const plans = plansOf((sql) => minCdcReplayableSeq(sql));

        expect(plans[0]).toContain("SEARCH __cdc_log USING INDEX __cdc_log_payload_gap");
    });
});
