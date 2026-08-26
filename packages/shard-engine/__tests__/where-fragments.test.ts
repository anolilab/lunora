import { describe, expect, it } from "vitest";

import { jsonPath, jsonPathSql, serializeSqlValue } from "../src/do-sql";
import { renderSql } from "../src/drizzle";
import type { TextFragment } from "../src/where-fragments";
import { rawText, textFragments } from "../src/where-fragments";
import type { WhereSqlStrategy } from "../src/where-sql";
import { compileWhereSql } from "../src/where-sql";
import type { WhereInput } from "../src/where-types";

/**
 * `compileWhereSql` is one traversal with two output builders: drizzle for
 * `@lunora/sql-store`, whose four dialects need drizzle to own placeholder
 * syntax, and text for the Durable Object, which has one dialect and was paying
 * 5.35µs a read to build and render what costs 0.10µs to assemble directly.
 *
 * The entire basis for the second is that it emits the SAME statement. So these
 * compile every predicate BOTH ways and compare the rendered text and the bound
 * parameters — including their ORDER, which is the half that fails silently: a
 * builder that transposes parameters still produces runnable SQL that binds
 * cleanly and answers the wrong question.
 */

const drizzleStrategy: WhereSqlStrategy = { fieldRef: jsonPathSql, serialize: serializeSqlValue };
const textStrategy: WhereSqlStrategy<TextFragment> = { fieldRef: (field) => rawText(jsonPath(field)), serialize: serializeSqlValue };

/** Compile `where` both ways and return the two rendered forms. */
const bothWays = (where: WhereInput): { drizzle: { params: unknown[]; sql: string }; text: { params: unknown[]; sql: string } } => {
    const asDrizzle = compileWhereSql(where, drizzleStrategy);
    const asText = compileWhereSql(where, textStrategy, textFragments);

    return {
        drizzle: asDrizzle === undefined ? { params: [], sql: "" } : renderSql("sqlite", asDrizzle),
        text: asText === undefined ? { params: [], sql: "" } : { params: asText.params, sql: asText.text },
    };
};

describe("text and drizzle where-builders agree", () => {
    it.each([
        ["equality shorthand", { channelId: "c1" }],
        ["null shorthand", { deletedAt: null }],
        ["two fields", { authorId: "u1", channelId: "c1" }],
        ["eq operator", { seq: { eq: 3 } }],
        ["ne operator", { seq: { ne: 3 } }],
        ["ne null maps to IS NOT NULL", { seq: { ne: null } }],
        ["eq null maps to IS NULL", { seq: { eq: null } }],
        ["lt/lte/gt/gte", { seq: { gt: 1, gte: 2, lt: 9, lte: 8 } }],
        ["isNull true", { body: { isNull: true } }],
        ["isNull false", { body: { isNull: false } }],
        ["contains", { body: { contains: "hello" } }],
        ["in", { channelId: { in: ["a", "b", "c"] } }],
        ["notIn", { channelId: { notIn: ["a", "b"] } }],
        ["empty in matches nothing", { channelId: { in: [] } }],
        ["empty notIn matches everything", { channelId: { notIn: [] } }],
        ["boolean serialization", { archived: true }],
        ["AND group", { AND: [{ a: 1 }, { b: 2 }] }],
        ["OR group", { OR: [{ a: 1 }, { b: 2 }] }],
        ["empty OR matches nothing", { OR: [] }],
        ["empty AND is vacuous", { AND: [] }],
        ["NOT", { NOT: { a: 1 } }],
        ["nested AND/OR/NOT", { AND: [{ OR: [{ a: 1 }, { b: 2 }] }, { NOT: { c: 3 } }] }],
        ["deep nesting", { AND: [{ AND: [{ AND: [{ a: 1 }, { b: 2 }] }, { c: 3 }] }, { d: 4 }] }],
        ["mixed operators and groups", { AND: [{ seq: { gte: 5 } }, { OR: [{ body: { contains: "x" } }, { channelId: { in: ["a", "b"] } }] }] }],
    ])("compiles %s to identical sql and parameters", (_label, where) => {
        expect.assertions(2);

        const { drizzle, text } = bothWays(where);

        expect(text.sql).toBe(drizzle.sql);
        expect(text.params).toStrictEqual(drizzle.params);
    });

    it("agrees on a wide `in` that switches to the bounded json_each form", () => {
        expect.hasAssertions();

        // Past the placeholder budget the list binds as ONE json parameter. The
        // two builders have to switch at the same width, or one of them exceeds
        // workerd's 100-parameter cap where the other does not.
        const wide = { channelId: { in: Array.from({ length: 80 }, (_value, index) => `c${String(index)}`) } };
        const { drizzle, text } = bothWays(wide);

        expect(text.sql).toBe(drizzle.sql);
        expect(text.params).toStrictEqual(drizzle.params);
        expect(text.sql).toContain("json_each");
    });

    it("agrees on several lists sharing one statement budget", () => {
        expect.assertions(2);

        // The budget is split across every list in the tree, so two lists switch
        // to the bounded form earlier than one would. Both builders read the same
        // divided budget or they disagree about which lists are wide.
        const twoLists = {
            AND: [
                { authorId: { in: Array.from({ length: 30 }, (_value, index) => `u${String(index)}`) } },
                { channelId: { in: Array.from({ length: 30 }, (_value, index) => `c${String(index)}`) } },
            ],
        };
        const { drizzle, text } = bothWays(twoLists);

        expect(text.sql).toBe(drizzle.sql);
        expect(text.params).toStrictEqual(drizzle.params);
    });

    it("keeps parameters in placeholder order across a wide balanced tree", () => {
        expect.assertions(2);

        // `joinClauses` splits clauses in half rather than chaining, so the tree
        // is rebalanced on the way out. Parameters must still come back in the
        // order their placeholders appear, which a naive re-assembly loses.
        const many = {
            AND: Array.from({ length: 40 }, (_value, index) => {
                return { [`f${String(index)}`]: index };
            }),
        };
        const { drizzle, text } = bothWays(many);

        expect(text.sql).toBe(drizzle.sql);
        expect(text.params).toStrictEqual(Array.from({ length: 40 }, (_value, index) => index));
    });

    it("never concatenates a value into the text", () => {
        expect.assertions(2);

        // The injection-safety property: a value that looks like SQL has to come
        // back as a bound parameter, not as text.
        const nasty = { body: "'; DROP TABLE messages; --" };
        const { text } = bothWays(nasty);

        expect(text.sql).not.toContain("DROP TABLE");
        expect(text.params).toStrictEqual(["'; DROP TABLE messages; --"]);
    });
});
