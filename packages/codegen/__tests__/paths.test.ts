import { describe, expect, it } from "vitest";

import sanitizeNamespace from "../src/paths.js";

describe("sanitizeNamespace", () => {
    it("leaves a top-level file as its own namespace", () => {
        expect.assertions(2);

        expect(sanitizeNamespace("messages")).toBe("messages");
        expect(sanitizeNamespace("index")).toBe("index");
    });

    it("collapses a directory's index to the directory name (component convention)", () => {
        expect.assertions(2);

        // cirrus/ratelimit/index.ts → api.ratelimit.* (not api.ratelimit_index.*)
        expect(sanitizeNamespace("ratelimit/index")).toBe("ratelimit");
        expect(sanitizeNamespace("billing/stripe/index")).toBe("billing_stripe");
    });

    it("flattens non-index nested paths with underscores", () => {
        expect.assertions(2);

        expect(sanitizeNamespace("ratelimit/queries")).toBe("ratelimit_queries");
        expect(sanitizeNamespace("foo/bar")).toBe("foo_bar");
    });

    it("only drops a trailing /index, not an index-prefixed segment", () => {
        expect.assertions(1);

        expect(sanitizeNamespace("indexers/main")).toBe("indexers_main");
    });
});
