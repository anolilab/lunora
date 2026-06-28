import { findLunoraSolution } from "@lunora/codegen";
import { describe, expect, it } from "vitest";

import { lunoraSolutionFinder, lunoraSolutionFinders } from "../src/solution-finders";

/**
 * Real messages Lunora throws, captured from the source. Codegen/schema
 * failures reach the overlay's finders with `name === "Error"` (pushed through
 * `server.hot.send`), so the finder must recognize them on the message text
 * alone. The exact id each message maps to is asserted in `@lunora/codegen`'s
 * `solutions` test — here we only check the overlay finder delegates correctly.
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

describe("lunoraSolutionFinder", () => {
    it("exposes a single finder with a high priority and a stable name", () => {
        expect.assertions(3);

        expect(lunoraSolutionFinders).toHaveLength(1);
        expect(lunoraSolutionFinder.name).toBe("lunora");
        expect(lunoraSolutionFinder.priority).toBeGreaterThanOrEqual(100);
    });

    it.each(Object.entries(CODEGEN_MESSAGES))("returns the codegen solution for the %s error", async (_key, message) => {
        expect.assertions(2);

        // The finder is a thin wrapper over `@lunora/codegen`'s shared table: it
        // must surface exactly that table's `{ header, body }` for the message.
        const expected = findLunoraSolution(message);
        const solution = await lunoraSolutionFinder.handle({ message, name: "Error" }, { file: "", line: 0 });

        expect(solution?.header).toBe(expected?.header);
        expect(solution?.body).toBe(expected?.body);
    });

    it("defers (returns undefined) for unrelated errors", async () => {
        expect.assertions(2);

        const generic = await lunoraSolutionFinder.handle({ message: "TypeError: x is not a function", name: "TypeError" }, { file: "a.ts", line: 1 });

        expect(generic).toBeUndefined();

        // A missing/blank message must never throw and must defer.
        const empty = await lunoraSolutionFinder.handle({ message: "", name: "Error" }, { file: "", line: 0 });

        expect(empty).toBeUndefined();
    });
});
