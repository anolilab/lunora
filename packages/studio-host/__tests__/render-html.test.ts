import { describe, expect, it } from "vitest";

import renderStudioHtml from "../src/render-html";

describe("renderStudioHtml", () => {
    it("injects the basepath and references the given asset URLs", () => {
        expect.assertions(4);

        const html = renderStudioHtml({ basePath: "/__cirrus", scriptSrc: "/__cirrus/studio.js", styleHref: "/__cirrus/styles.css" });

        expect(html).toContain('window.__CIRRUS_BASE_PATH__="/__cirrus";');
        expect(html).toContain('src="/__cirrus/studio.js"');
        expect(html).toContain('href="/__cirrus/styles.css"');
        // No token provided → no token global is injected.
        expect(html).not.toContain("__CIRRUS_ADMIN_TOKEN__");
    });

    it("injects the admin token when provided, escaping `<` for safe inline embedding", () => {
        expect.assertions(2);

        const html = renderStudioHtml({ adminToken: "tok<en", basePath: "/", scriptSrc: "/studio.js", styleHref: "/styles.css" });

        // `<` is escaped to its `\u003c` form so it cannot close the inline <script> early.
        expect(html).toContain(String.raw`"tok\u003cen"`);
        expect(html).not.toContain("tok<en");
    });
});
