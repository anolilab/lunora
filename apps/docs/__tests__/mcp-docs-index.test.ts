import { describe, expect, it } from "vitest";

import { slugsFor } from "@/lib/docs-slug";

/**
 * `slugsFor` feeds every `lunora_get_doc` lookup and hard-codes the `/docs`
 * mount point, so it is the thing that breaks silently if the fumadocs base
 * path ever moves — and the only part of this module that can be tested without
 * standing up the whole content pipeline.
 */
describe("slugsFor", () => {
    it.each([
        ["/docs/sharding", ["sharding"]],
        ["/docs/guides/sharding", ["guides", "sharding"]],
        ["/docs", []],
        ["/docs/", []],
    ])("maps %s to the loader's slug array", (url, expected) => {
        expect.assertions(1);

        expect(slugsFor(url)).toStrictEqual(expected);
    });

    it("matches /docs as a path segment, not a prefix", () => {
        expect.assertions(1);

        // `/docsomething` is not under the docs tree; slicing it as a prefix
        // would produce the nonsense slug ["omething"].
        expect(slugsFor("/docsomething")).toStrictEqual(["docsomething"]);
    });

    it("passes a url outside the docs tree through unchanged", () => {
        expect.assertions(1);

        expect(slugsFor("/blog/post")).toStrictEqual(["blog", "post"]);
    });
});
