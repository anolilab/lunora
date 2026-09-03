import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DANGLING_RESULT_CAP, findDanglingReferences } from "../src/storage-correlation";
import createSqliteExec from "./_helpers/node-sqlite";

describe("storage-correlation", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();

        // `avatars` stores its key in the `__doc__` blob; `banners` in a physical
        // column — exercising both column-resolution paths.
        database.raw(`CREATE TABLE "avatars" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
        database.raw(
            `INSERT INTO "avatars" VALUES ('a1', 1, '{"fileKey":"u/1.png"}'), ('a2', 2, '{"fileKey":"u/gone.png"}'), ('a3', 3, '{"fileKey":"u/1.png"}')`,
        );
        database.raw(`CREATE TABLE "banners" ("id" TEXT PRIMARY KEY, "image" TEXT)`);
        database.raw(`INSERT INTO "banners" VALUES ('b1', 'u/2.png'), ('b2', 'u/missing.png'), ('b3', NULL), ('b4', '')`);
    });

    afterEach(() => {
        database.close();
    });

    describe("findDanglingReferences", () => {
        it("flags record fields pointing at a key absent from the live bucket (doc + physical columns)", () => {
            expect.assertions(2);

            const live = new Set(["u/1.png", "u/2.png"]);
            const { references } = findDanglingReferences(database.sql, { avatars: ["fileKey"], banners: ["image"] }, live);

            expect(references.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
                { column: "fileKey", id: "a2", key: "u/gone.png", table: "avatars" },
                { column: "image", id: "b2", key: "u/missing.png", table: "banners" },
            ]);
            // The owned references (u/1.png ×2, u/2.png) are not dangling.
            expect(references).toHaveLength(2);
        });

        it("addresses a doc field whose name contains a double quote", () => {
            expect.assertions(1);

            // A JSON path is not a SQL identifier: doubling `"` (the identifier
            // rule) emits `$."file""key"`, which SQLite resolves to nothing and
            // reads back as NULL, so the scan saw no values and reported nothing
            // dangling. `$."file\"key"` — the JSON string escape, from
            // `shared/json-path-segment.ts` — reads the value.
            database.raw(`CREATE TABLE "odd" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(`INSERT INTO "odd" VALUES ('o1', 1, ?)`, JSON.stringify({ 'file"key': "u/gone.png" }));

            const { references } = findDanglingReferences(database.sql, { odd: ['file"key'] }, new Set(["u/1.png"]));

            expect(references).toEqual([{ column: 'file"key', id: "o1", key: "u/gone.png", table: "odd" }]);
        });

        it("reports no dangling references when every value resolves to a live object (owned case)", () => {
            expect.assertions(2);

            const live = new Set(["u/1.png", "u/2.png", "u/gone.png", "u/missing.png"]);
            const result = findDanglingReferences(database.sql, { avatars: ["fileKey"], banners: ["image"] }, live);

            expect(result.references).toEqual([]);
            expect(result.truncated).toBe(false);
        });

        it("ignores NULL and empty storage values (they can't dangle)", () => {
            expect.assertions(1);

            // b3 (NULL) and b4 ('') must never appear, even with an empty live set.
            const { references } = findDanglingReferences(database.sql, { banners: ["image"] }, new Set());

            expect(references.map((reference) => reference.id).toSorted((a, b) => a.localeCompare(b))).toEqual(["b1", "b2"]);
        });

        it("accepts any iterable of live keys, not just a Set", () => {
            expect.assertions(1);

            const { references } = findDanglingReferences(database.sql, { avatars: ["fileKey"] }, ["u/1.png"]);

            expect(references).toEqual([{ column: "fileKey", id: "a2", key: "u/gone.png", table: "avatars" }]);
        });

        it("skips unknown / internal tables without throwing", () => {
            expect.assertions(1);

            const { references } = findDanglingReferences(database.sql, { _cf_KV: ["image"], avatars: ["fileKey"], nope: ["x"] }, new Set(["u/1.png"]));

            expect(references).toEqual([{ column: "fileKey", id: "a2", key: "u/gone.png", table: "avatars" }]);
        });

        it("returns an empty, non-truncated result for a schema with no storage columns", () => {
            expect.assertions(1);

            expect(findDanglingReferences(database.sql, {}, new Set(["u/1.png"]))).toEqual({ references: [], scanned: 0, truncated: false });
        });

        it("counts every non-empty storage value it examined in `scanned`", () => {
            expect.assertions(1);

            // avatars: a1/a2/a3 = 3 non-empty; banners: b1/b2 = 2 (b3 NULL, b4 '').
            const { scanned } = findDanglingReferences(database.sql, { avatars: ["fileKey"], banners: ["image"] }, new Set(["u/1.png"]));

            expect(scanned).toBe(5);
        });

        it("caps the result at DANGLING_RESULT_CAP and flags truncation", () => {
            expect.assertions(2);

            database.raw(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "file" TEXT)`);

            const values: string[] = [];

            for (let index = 0; index < DANGLING_RESULT_CAP + 25; index += 1) {
                values.push(`('d${String(index)}', 'missing/${String(index)}.bin')`);
            }

            database.raw(`INSERT INTO "docs" VALUES ${values.join(", ")}`);

            // No live key matches, so every row dangles — but the result is capped.
            const result = findDanglingReferences(database.sql, { docs: ["file"] }, new Set());

            expect(result.references).toHaveLength(DANGLING_RESULT_CAP);
            expect(result.truncated).toBe(true);
        });
    });
});
