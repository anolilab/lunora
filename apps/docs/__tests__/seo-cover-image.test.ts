import { describe, expect, it } from "vitest";

import { coverImageUrl, DEFAULT_OG_IMAGE, SITE_URL } from "@/lib/seo";

describe("coverImageUrl", () => {
    it.each([
        // The shared social card is not the post's own art. Six posts declare it,
        // and treating it as real is what put one image on all of them.
        ["/og-default.jpg", undefined],
        [DEFAULT_OG_IMAGE, undefined],
        // `image:` with no value is `null` in YAML, `image: ""` is the empty
        // string; frontmatter is typed `image?: string` and never validated.
        // eslint-disable-next-line unicorn/no-null -- the exact value YAML produces for a bare `image:` key
        [null, undefined],
        ["", undefined],
        ["   ", undefined],
        [undefined, undefined],
    ])("treats %o as no cover art", (image, expected) => {
        expect.assertions(1);

        expect(coverImageUrl(image)).toBe(expected);
    });

    it("resolves a site-relative path against the site origin", () => {
        expect.assertions(1);

        expect(coverImageUrl("/blog/studio/home.webp")).toBe(`${SITE_URL}/blog/studio/home.webp`);
    });

    it("leaves an absolute url alone", () => {
        expect.assertions(1);

        // Concatenating the origin onto this is how it became
        // `https://lunora.sh/https://cdn.example.com/cover.png`.
        expect(coverImageUrl("https://cdn.example.com/cover.png")).toBe("https://cdn.example.com/cover.png");
    });
});
