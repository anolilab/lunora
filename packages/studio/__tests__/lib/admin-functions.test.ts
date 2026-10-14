import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS } from "../../src/lib/admin";

const entries = Object.entries(ADMIN_FUNCTIONS);

/**
 * `ADMIN_FUNCTIONS` spells `__lunora_admin__:` inline in every one of its values
 * rather than interpolating `ADMIN_FUNCTION_PREFIX`, so the values stay emittable
 * under `--isolatedDeclarations`. That is a deliberate duplication, and a
 * duplication nothing enforces drifts: an entry added with a typo'd or missing
 * prefix is not intercepted by `ShardDO` at all — it falls through to user
 * dispatch as an ordinary function path, so the read fails (or, worse, resolves
 * against an app function of that name) instead of being gated by
 * `LUNORA_ADMIN_TOKEN`. TypeScript cannot see the mismatch: every value is just a
 * string literal.
 */
describe("aDMIN_FUNCTIONS", () => {
    it("carries the reserved prefix on every path", () => {
        expect.assertions(1);

        expect(entries.filter(([, path]) => !path.startsWith(ADMIN_FUNCTION_PREFIX))).toStrictEqual([]);
    });

    // The key IS the RPC name; a value whose suffix has drifted from its key
    // silently invokes a different (or non-existent) admin RPC than the call site
    // reads.
    it("names each path after its own key", () => {
        expect.assertions(1);

        expect(entries.filter(([key, path]) => path.slice(ADMIN_FUNCTION_PREFIX.length) !== key)).toStrictEqual([]);
    });

    it("maps every key to a distinct path", () => {
        expect.assertions(1);

        expect(new Set(entries.map(([, path]) => path)).size).toBe(entries.length);
    });

    it("is not empty (a vacuous pass would make the checks above meaningless)", () => {
        expect.assertions(1);

        // Deliberately `0` and not a headcount: the point is that the assertions
        // above iterated something, and pinning the exact number would fail the day
        // someone legitimately adds or removes an admin function.
        expect(entries.length).toBeGreaterThan(0);
    });
});
