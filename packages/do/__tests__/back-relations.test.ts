import type { SqlExec } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_BACK_RELATION_IDS, MAX_BACK_RELATIONS, readBackRelationCounts } from "../src/back-relations";
import createSqliteExec from "./_helpers/node-sqlite";

/** A doc-stored child table, the shape lunora actually writes. */
const seed = (sql: SqlExec): void => {
    sql.exec(`CREATE TABLE "messages" (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, "__doc__" TEXT NOT NULL)`);

    for (const [id, author] of [
        ["m1", "u1"],
        ["m2", "u1"],
        ["m3", "u2"],
    ]) {
        sql.exec(`INSERT INTO "messages" (id, _creationTime, "__doc__") VALUES (?, 0, ?)`, id, JSON.stringify({ authorId: author }));
    }
};

describe("readBackRelationCounts", () => {
    let sql: SqlExec;

    beforeEach(() => {
        sql = createSqliteExec().sql;
        seed(sql);
    });

    it("counts children per parent through a doc-stored foreign key", () => {
        expect.assertions(2);

        const { relations } = readBackRelationCounts(sql, { ids: ["u1", "u2"], relations: [{ column: "authorId", table: "messages" }] });

        expect(relations[0]?.counts.u1).toBe(2);
        expect(relations[0]?.counts.u2).toBe(1);
    });

    it("addresses a doc field whose name contains a double quote", () => {
        expect.assertions(1);

        // A JSON path is not a SQL identifier: doubling `"` (the identifier
        // rule) emits `$."say""hi"`, which SQLite resolves to nothing and reads
        // back as NULL, so every count silently came out empty. `$."say\"hi"`
        // — the JSON string escape, from `shared/json-path-segment.ts` — reads
        // the value.
        sql.exec(`CREATE TABLE "notes" (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
        sql.exec(`INSERT INTO "notes" (id, _creationTime, "__doc__") VALUES (?, 0, ?)`, "n1", JSON.stringify({ 'say"hi': "u1" }));

        const { relations } = readBackRelationCounts(sql, { ids: ["u1"], relations: [{ column: 'say"hi', table: "notes" }] });

        expect(relations[0]?.counts.u1).toBe(1);
    });

    it("omits parents with no children rather than reporting zero rows", () => {
        expect.assertions(1);

        // Absent means zero; the client renders 0. Emitting a row per childless
        // parent would make the payload grow with the page for no information.
        const { relations } = readBackRelationCounts(sql, { ids: ["u1", "nobody"], relations: [{ column: "authorId", table: "messages" }] });

        expect(relations[0]?.counts.nobody).toBeUndefined();
    });

    it("skips an unresolvable relation instead of failing the whole page", () => {
        expect.assertions(2);

        // Schema metadata can lag the live database — a table dropped since the
        // page loaded must not blank every other count.
        const { relations } = readBackRelationCounts(sql, {
            ids: ["u1"],
            relations: [
                { column: "authorId", table: "ghost" },
                { column: "authorId", table: "messages" },
            ],
        });

        expect(relations).toHaveLength(1);
        expect(relations[0]?.table).toBe("messages");
    });

    it("returns nothing for an empty request", () => {
        expect.assertions(2);

        expect(readBackRelationCounts(sql, { ids: [], relations: [{ column: "authorId", table: "messages" }] }).relations).toStrictEqual([]);
        expect(readBackRelationCounts(sql, { ids: ["u1"], relations: [] }).relations).toStrictEqual([]);
    });

    it("bounds the fan-out so one request cannot resolve unlimited relations", () => {
        expect.assertions(1);

        const many = Array.from({ length: MAX_BACK_RELATIONS + 5 }, () => {
            return { column: "authorId", table: "messages" };
        });

        expect(readBackRelationCounts(sql, { ids: ["u1"], relations: many }).relations.length).toBeLessThanOrEqual(MAX_BACK_RELATIONS);
    });

    it("keeps a full page's id list inside workerd's 100-bound-parameter cap", () => {
        expect.assertions(2);

        // The Studio offers a 100-row page size. A literal `IN (?, ?, …)` over
        // one blows workerd's `SQLITE_LIMIT_VARIABLE_NUMBER` (100) and the
        // statement fails to PREPARE — which `node:sqlite` cannot reproduce,
        // because its stock build allows 500,000. So assert on what is bound,
        // not on whether the local engine happens to accept it.
        const bound: unknown[][] = [];
        const probe: SqlExec = {
            exec: <Row>(text: string, ...params: unknown[]) => {
                bound.push(params);

                return sql.exec<Row>(text, ...params);
            },
        };

        const ids = ["u1", ...Array.from({ length: MAX_BACK_RELATION_IDS - 1 }, (_, index) => `filler-${String(index)}`)];
        const { relations } = readBackRelationCounts(probe, { ids, relations: [{ column: "authorId", table: "messages" }] });

        expect(relations[0]?.counts.u1).toBe(2);
        expect(Math.max(...bound.map((params) => params.length))).toBeLessThanOrEqual(100);
    });

    it("de-duplicates parent ids", () => {
        expect.assertions(1);

        // A page cannot contain a duplicate id, but a hand-built request can —
        // and repeating it would inflate nothing but the IN list.
        const { relations } = readBackRelationCounts(sql, { ids: ["u1", "u1", "u1"], relations: [{ column: "authorId", table: "messages" }] });

        expect(relations[0]?.counts.u1).toBe(2);
    });
});
