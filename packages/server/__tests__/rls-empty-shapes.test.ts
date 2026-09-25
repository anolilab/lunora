import { DatabaseSync } from "node:sqlite";

import type { WhereSqlStrategy } from "@lunora/shard-engine";
import { compileWhereSql, renderSql } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allowAll } from "../src/rls/predicates";
import type { WhereInput } from "../src/rls/types";
import { matchesWhere } from "../src/rls/where-match";

/**
 * Empty `where` shapes — `{}` (what `allowAll()` returns), `{ AND: [] }`,
 * `{ OR: [] }`, and each of them nested — must mean the same thing to the SQL
 * compiler as to the JS matcher `rls()` runs on every row.
 *
 * They did not: the compiler dropped a branch that compiled to nothing, so
 * `{ OR: [allowAll(), { role: "admin" }] }` became `"role" = ?` and an admin
 * whose policy branch was `allowAll()` saw only the rows the OTHER branch
 * admitted. Each row here runs the compiled SQL on `node:sqlite` and compares it
 * with `matchesWhere` over the same three rows.
 */
const database = new DatabaseSync(":memory:");

const ROWS: Record<string, unknown>[] = [
    { id: "n", role: null },
    { id: "a", role: "admin" },
    { id: "m", role: "member" },
];

const strategy: WhereSqlStrategy = {
    fieldRef: (field) => sql`"docs".${sql.identifier(field)}`,
    serialize: (value) => value,
};

const viaSql = (where: WhereInput): string[] => {
    const condition = compileWhereSql(where as never, strategy);
    const query = condition === undefined ? sql`SELECT "docs"."id" FROM "docs"` : sql`SELECT "docs"."id" FROM "docs" WHERE ${condition}`;
    const { params, sql: text } = renderSql("sqlite", sql`${query} ORDER BY "docs"."id"`);

    return database
        .prepare(text)
        .all(...(params as never[]))
        .map((row) => (row as { id: string }).id);
};

const viaMatcher = (where: WhereInput): string[] =>
    ROWS.filter((row) => matchesWhere(row, where))
        .map((row) => String(row["id"]))
        .toSorted((left, right) => left.localeCompare(right));

const admin = { role: "admin" };

describe("empty where shapes: SQL compiler vs JS matcher", () => {
    beforeAll(() => {
        database.exec(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "role" TEXT)`);
        database.exec(`INSERT INTO "docs" VALUES ('n', NULL), ('a', 'admin'), ('m', 'member')`);
    });

    afterAll(() => {
        database.close();
    });

    it.each([
        ["{}", {}, ["a", "m", "n"]],
        ["allowAll()", allowAll(), ["a", "m", "n"]],
        ["AND []", { AND: [] }, ["a", "m", "n"]],
        ["OR []", { OR: [] }, []],
        ["AND [{}]", { AND: [{}] }, ["a", "m", "n"]],
        ["AND [{}, admin]", { AND: [{}, admin] }, ["a"]],
        ["OR [{}]", { OR: [{}] }, ["a", "m", "n"]],
        ["OR [allowAll(), admin]", { OR: [allowAll(), admin] }, ["a", "m", "n"]],
        ["OR [admin, AND []]", { OR: [admin, { AND: [] }] }, ["a", "m", "n"]],
        ["OR [AND []]", { OR: [{ AND: [] }] }, ["a", "m", "n"]],
        ["OR [OR [], admin]", { OR: [{ OR: [] }, admin] }, ["a"]],
        ["OR [OR [{}], member]", { OR: [{ OR: [{}] }, { role: "member" }] }, ["a", "m", "n"]],
        ["AND [OR []]", { AND: [{ OR: [] }] }, []],
        ["AND [OR [{}, admin], member]", { AND: [{ OR: [{}, admin] }, { role: "member" }] }, ["m"]],
        ["NOT {}", { NOT: {} }, []],
        ["NOT AND []", { NOT: { AND: [] } }, []],
        ["NOT OR []", { NOT: { OR: [] } }, ["a", "m", "n"]],
        ["NOT OR [{}, admin]", { NOT: { OR: [{}, admin] } }, []],
        ["OR [NOT {}, admin]", { OR: [{ NOT: {} }, admin] }, ["a"]],
    ] as [string, WhereInput, string[]][])("%s", (_label, where, expected) => {
        expect.assertions(2);

        expect(viaMatcher(where)).toStrictEqual(expected);
        expect(viaSql(where)).toStrictEqual(expected);
    });
});
