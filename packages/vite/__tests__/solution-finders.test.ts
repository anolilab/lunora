import { describe, expect, it } from "vitest";

import { LUNORA_SOLUTION_RULES, lunoraSolutionFinder, lunoraSolutionFinders } from "../src/solution-finders";

/**
 * Real messages Lunora throws, captured from the source. Codegen/schema
 * failures reach the overlay's finders with `name === "Error"` (pushed through
 * `server.hot.send`), so every rule must match on the message text alone.
 */
const CODEGEN_MESSAGES = {
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

const expectedId: Record<keyof typeof CODEGEN_MESSAGES, string> = {
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

describe("lunoraSolutionFinder", () => {
    it("exposes a single finder with a high priority and a stable name", () => {
        expect.assertions(3);

        expect(lunoraSolutionFinders).toHaveLength(1);
        expect(lunoraSolutionFinder.name).toBe("lunora");
        expect(lunoraSolutionFinder.priority).toBeGreaterThanOrEqual(100);
    });

    it.each(Object.entries(CODEGEN_MESSAGES))("returns a solution for the %s error", async (key, message) => {
        expect.assertions(4);

        // Each real message must match exactly one rule — this guards the loose
        // `includes(...)` matchers against silently co-matching a second rule
        // (where ordering, not the predicate, would decide the winner).
        const allMatches = LUNORA_SOLUTION_RULES.filter((rule) => rule.test(message));

        expect(allMatches).toHaveLength(1);
        expect(allMatches[0]?.id).toBe(expectedId[key as keyof typeof CODEGEN_MESSAGES]);

        const solution = await lunoraSolutionFinder.handle({ message, name: "Error" }, { file: "", line: 0 });

        expect(solution?.header).not.toBe("");
        expect(typeof solution?.body).toBe("string");
    });

    it("defers (returns undefined) for unrelated errors", async () => {
        expect.assertions(2);

        const generic = await lunoraSolutionFinder.handle({ message: "TypeError: x is not a function", name: "TypeError" }, { file: "a.ts", line: 1 });

        expect(generic).toBeUndefined();

        // A missing/blank message must never throw and must defer.
        const empty = await lunoraSolutionFinder.handle({ message: "", name: "Error" }, { file: "", line: 0 });

        expect(empty).toBeUndefined();
    });

    it("keeps every rule id unique", () => {
        expect.assertions(1);

        const ids = LUNORA_SOLUTION_RULES.map((rule) => rule.id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});
