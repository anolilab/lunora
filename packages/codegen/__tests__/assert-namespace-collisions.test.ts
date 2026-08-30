import { describe, expect, it } from "vitest";

import assertNoNamespaceCollisions from "../src/assert-namespace-collisions";

describe("assertNoNamespaceCollisions", () => {
    it("accepts distinct namespaces", () => {
        expect.assertions(1);

        expect(() => {
            assertNoNamespaceCollisions(["messages", "channels", "ratelimit/index", "ratelimit/queries"]);
        }).not.toThrow();
    });

    it("accepts the same file listed twice (functions + mutators share a file)", () => {
        expect.assertions(1);

        expect(() => {
            assertNoNamespaceCollisions(["messages", "messages"]);
        }).not.toThrow();
    });

    it("rejects two files whose non-identifier characters sanitize to the same namespace", () => {
        expect.assertions(1);

        // `sanitizeNamespace` maps every non-identifier character to `_`, so both
        // become `a_b` and `_generated/api.ts` declares the key twice — TS2300
        // inside generated code, previously with nothing pointing at the cause.
        expect(() => {
            assertNoNamespaceCollisions(["a-b", "a_b"]);
        }).toThrow(/both map to the api namespace "a_b"/);
    });

    it("rejects a `foo/index` that collides with a sibling `foo`", () => {
        expect.assertions(1);

        expect(() => {
            assertNoNamespaceCollisions(["foo", "foo/index"]);
        }).toThrow(/both map to the api namespace "foo"/);
    });
});
