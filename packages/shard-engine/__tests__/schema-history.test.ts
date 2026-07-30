import { beforeEach, describe, expect, it } from "vitest";

import type { SchemaSnapshot } from "../../../shared/schema-snapshot";
import { hashSchemaSnapshot, serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
import type { SqlExec } from "../src/ctx-db";
import { readSchemaHistory, readSchemaVersion, recordSchemaVersion, SCHEMA_HISTORY_MAX_VERSIONS } from "../src/schema-history";
import createSqliteExec from "./_helpers/node-sqlite";

const snapshotWith = (tables: string[]): SchemaSnapshot => {
    return {
        migrationIds: [],
        tables: Object.fromEntries(
            tables.map((name) => [name, { fields: { id: { kind: "id", optional: false } }, indexes: {}, relations: {}, shardMode: "root" }]),
        ),
        version: 1,
    };
};

const record = (sql: SqlExec, snapshot: SchemaSnapshot, now?: number): boolean =>
    recordSchemaVersion(sql, hashSchemaSnapshot(snapshot), serializeSchemaSnapshot(snapshot), now);

describe("schema-history ledger", () => {
    let sql: SqlExec;

    beforeEach(() => {
        sql = createSqliteExec().sql;
    });

    it("reports no history before anything is recorded", () => {
        expect.assertions(1);

        expect(readSchemaHistory(sql)).toStrictEqual([]);
    });

    it("appends a version and reads it back newest-first", () => {
        expect.assertions(4);

        expect(record(sql, snapshotWith(["users"]), 1000)).toBe(true);
        expect(record(sql, snapshotWith(["users", "posts"]), 2000)).toBe(true);

        const history = readSchemaHistory(sql);

        expect(history.map((row) => row.seq)).toStrictEqual([2, 1]);
        expect(history[0]?.appliedAt).toBe(2000);
    });

    it("is content-addressed: an unchanged schema does not append", () => {
        expect.assertions(3);

        expect(record(sql, snapshotWith(["users"]))).toBe(true);
        // Every subsequent cold start on the same schema hits this path.
        expect(record(sql, snapshotWith(["users"]))).toBe(false);
        expect(readSchemaHistory(sql)).toHaveLength(1);
    });

    it("re-links a reverted schema instead of duplicating it", () => {
        expect.assertions(2);

        const first = snapshotWith(["users"]);

        record(sql, first);
        record(sql, snapshotWith(["users", "posts"]));

        // Revert: the original hash is already stored, so no new row.
        expect(record(sql, first)).toBe(false);
        expect(readSchemaHistory(sql)).toHaveLength(2);
    });

    it("omits the snapshot payload from the list and includes it in the detail", () => {
        expect.assertions(3);

        const snapshot = snapshotWith(["users"]);

        record(sql, snapshot);

        expect(readSchemaHistory(sql)[0]?.snapshotJson).toBeUndefined();

        const detail = readSchemaVersion(sql, hashSchemaSnapshot(snapshot));

        expect(detail?.snapshotJson).toBe(serializeSchemaSnapshot(snapshot));
        expect(readSchemaVersion(sql, "not-a-real-hash")).toBeUndefined();
    });

    it("prunes the oldest versions past the cap", () => {
        expect.assertions(3);

        for (let index = 0; index < SCHEMA_HISTORY_MAX_VERSIONS + 5; index += 1) {
            record(sql, snapshotWith([`table_${String(index)}`]));
        }

        const history = readSchemaHistory(sql);

        expect(history).toHaveLength(SCHEMA_HISTORY_MAX_VERSIONS);
        // The newest survive; the first five are gone.
        expect(history[0]?.seq).toBe(SCHEMA_HISTORY_MAX_VERSIONS + 5);
        expect(history.at(-1)?.seq).toBe(6);
    });

    it("never throws when the storage handle fails", () => {
        expect.assertions(3);

        const broken = {
            exec: () => {
                throw new Error("storage unavailable");
            },
        } as unknown as SqlExec;

        // A shard that cannot record its schema version still has to boot.
        expect(record(broken, snapshotWith(["users"]))).toBe(false);
        expect(readSchemaHistory(broken)).toStrictEqual([]);
        expect(readSchemaVersion(broken, "abc")).toBeUndefined();
    });

    it("ignores an empty hash or payload", () => {
        expect.assertions(2);

        expect(recordSchemaVersion(sql, "", "{}")).toBe(false);
        expect(recordSchemaVersion(sql, "abc", "")).toBe(false);
    });
});
