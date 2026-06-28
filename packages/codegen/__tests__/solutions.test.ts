import { describe, expect, it } from "vitest";

import { findLunoraSolution, LUNORA_SOLUTION_RULES } from "../src/solutions";

/**
 * Real messages Lunora throws, captured from the source. Consumers (the Vite
 * overlay, the `lunora dev` CLI) match on the message text alone, so these are
 * the exact strings the rules must recognize.
 */
const LUNORA_MESSAGES = {
    duplicate: 'defineSchema(...).extend(...): table "todos" already exists — another extension with the same key already contributed it.',
    exportGap: "[lunora] 1 declared binding is not exported by your worker entry — `wrangler deploy` will fail.",
    jurisdiction: 'unknown jurisdiction "moon" — expected "eu", "us", or "fedramp"',
    notObjectLiteral: "defineSchema() expects an object literal",
    occ: 'optimistic concurrency conflict on "todos" — the row changed during this mutation; refetch and retry',
    reserved: 'table name "insert" is reserved — it collides with a `ctx.db` member (one of "insert", "patch"). Rename the table.',
    schemaMissing: "defineSchema() not found in /app/lunora/schema.ts",
    uniqueLiteral: '`unique` must be a literal `true` or `false`, got "someFlag"',
    uniqueRuntime: 'unique constraint violation on "todos"',
} as const;

const expectedId: Record<keyof typeof LUNORA_MESSAGES, string> = {
    duplicate: "lunora-table-duplicate",
    exportGap: "lunora-worker-entry-export-gap",
    jurisdiction: "lunora-jurisdiction",
    notObjectLiteral: "lunora-schema-not-object-literal",
    occ: "lunora-runtime-occ",
    reserved: "lunora-table-reserved",
    schemaMissing: "lunora-schema-missing",
    uniqueLiteral: "lunora-unique-literal",
    uniqueRuntime: "lunora-runtime-unique",
};

describe("findLunoraSolution", () => {
    it.each(Object.entries(LUNORA_MESSAGES))("matches exactly one rule for the %s error", (key, message) => {
        expect.assertions(4);

        // Each real message must match exactly one rule — this guards the loose
        // `includes(...)` matchers against silently co-matching a second rule
        // (where ordering, not the predicate, would decide the winner).
        const allMatches = LUNORA_SOLUTION_RULES.filter((rule) => rule.test(message));

        expect(allMatches).toHaveLength(1);
        expect(allMatches[0]?.id).toBe(expectedId[key as keyof typeof LUNORA_MESSAGES]);

        const solution = findLunoraSolution(message);

        expect(solution?.id).toBe(expectedId[key as keyof typeof LUNORA_MESSAGES]);
        expect(typeof solution?.body).toBe("string");
    });

    it("returns undefined for unrelated and empty messages", () => {
        expect.assertions(2);

        expect(findLunoraSolution("TypeError: x is not a function")).toBeUndefined();
        expect(findLunoraSolution("")).toBeUndefined();
    });

    it("keeps every rule id unique", () => {
        expect.assertions(1);

        const ids = LUNORA_SOLUTION_RULES.map((rule) => rule.id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});
