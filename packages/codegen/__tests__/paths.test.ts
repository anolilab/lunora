import { describe, expect, it } from "vitest";

import { namespaceSegments, sanitizeNamespace } from "../src/paths";

describe("sanitizeNamespace", () => {
    it("leaves a top-level file as its own namespace", () => {
        expect.assertions(2);

        expect(sanitizeNamespace("messages")).toBe("messages");
        expect(sanitizeNamespace("index")).toBe("index");
    });

    it("collapses a directory's index to the directory name (component convention)", () => {
        expect.assertions(2);

        // lunora/ratelimit/index.ts → api.ratelimit.* (not api.ratelimit_index.*)
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

describe(namespaceSegments, () => {
    it("splits a file path into the nested api.* key path the dispatch namespace joins", () => {
        expect.assertions(3);

        expect(namespaceSegments("billing/invoices")).toStrictEqual(["billing", "invoices"]);
        expect(namespaceSegments("my-module/index")).toStrictEqual(["my_module"]);
        expect(namespaceSegments("my-module/2fa").join("_")).toBe(sanitizeNamespace("my-module/2fa"));
    });
});
