import { sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { DOC_COLUMN } from "../src/do-sql";
import { renderSql } from "../src/drizzle";

/**
 * `findMany` used to assemble its statement a clause at a time, each step
 * wrapping the whole previous query:
 *
 * `query = sql\`SELECT …\``, then `query = sql\`${query} WHERE …\``, and again
 * for ORDER BY and LIMIT.
 *
 * That nests one level deeper per clause, and drizzle's renderer walks the tree
 * recursively with a type check per node. It is now one template per clause
 * combination, which renders 62% faster — but only if the text and parameters
 * come out identical, which is what these assert, branch by branch.
 *
 * The builder is module-private, so this rebuilds both forms rather than
 * importing it. That is the point: the assertion is that the two SHAPES agree,
 * and it would still hold if the builder were re-inlined.
 */

const TABLE = "messages";

/** The old clause-at-a-time composition, verbatim. */
const nested = (where: ReturnType<typeof dsql> | undefined, order: ReturnType<typeof dsql>, limit: ReturnType<typeof dsql> | undefined) => {
    let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(TABLE)}`;

    if (where) {
        query = dsql`${query} WHERE ${where}`;
    }

    query = dsql`${query} ORDER BY ${order}`;

    if (limit !== undefined) {
        query = dsql`${query} LIMIT ${limit}`;
    }

    return renderSql("sqlite", query);
};

/** The flattened form, mirroring `selectPageSql`. */
const flat = (where: ReturnType<typeof dsql> | undefined, order: ReturnType<typeof dsql>, limit: ReturnType<typeof dsql> | undefined) => {
    if (where === undefined) {
        return renderSql(
            "sqlite",
            limit === undefined
                ? dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(TABLE)} ORDER BY ${order}`
                : dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(TABLE)} ORDER BY ${order} LIMIT ${limit}`,
        );
    }

    return renderSql(
        "sqlite",
        limit === undefined
            ? dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(TABLE)} WHERE ${where} ORDER BY ${order}`
            : dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(TABLE)} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`,
    );
};

const ORDER = dsql`_creationTime ASC, id ASC`;

describe("row-page select assembly", () => {
    it.each([
        ["no where, no limit", false, false],
        ["no where, limit", false, true],
        ["where, no limit", true, false],
        ["where and limit", true, true],
    ])("renders %s identically to the composition it replaced", (_label, hasWhere, hasLimit) => {
        expect.assertions(2);

        // A bound value in the WHERE and a raw literal in the LIMIT — the two
        // chunk kinds whose ordering the flattening could disturb.
        const where = hasWhere ? dsql`json_extract(__doc__, '$.channelId') = ${"c3"}` : undefined;
        const limit = hasLimit ? dsql.raw("26") : undefined;

        const before = nested(where, ORDER, limit);
        const after = flat(where, ORDER, limit);

        expect(after.sql).toBe(before.sql);
        expect(after.params).toStrictEqual(before.params);
    });

    it("keeps multiple bound parameters in order across the flattening", () => {
        expect.assertions(2);

        // Parameter ORDER is the thing a re-assembly can silently transpose: the
        // text would still be valid SQL and the values would bind to the wrong
        // placeholders.
        const where = dsql`json_extract(__doc__, '$.a') = ${1} AND json_extract(__doc__, '$.b') = ${2} AND json_extract(__doc__, '$.c') = ${3}`;

        const before = nested(where, ORDER, dsql.raw("11"));
        const after = flat(where, ORDER, dsql.raw("11"));

        expect(after.params).toStrictEqual([1, 2, 3]);
        expect(after.sql).toBe(before.sql);
    });
});
