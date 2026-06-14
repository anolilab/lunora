import { describe, expect, it } from "vitest";

import renderStudioHtml from "../../src/studio-host/render-html";

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

    it("injects the editable flag only when dataEditable is set", () => {
        expect.assertions(2);

        const editable = renderStudioHtml({ basePath: "/", dataEditable: true, scriptSrc: "/studio.js", styleHref: "/styles.css" });
        const readonly = renderStudioHtml({ basePath: "/", scriptSrc: "/studio.js", styleHref: "/styles.css" });

        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        expect(editable).toContain("window.__CIRRUS_DATA_EDITABLE__=true;");
        expect(readonly).not.toContain("__CIRRUS_DATA_EDITABLE__");
    });

    it("injects the run-as flag only when runAsIdentity is set", () => {
        expect.assertions(2);

        const runAs = renderStudioHtml({ basePath: "/", runAsIdentity: true, scriptSrc: "/studio.js", styleHref: "/styles.css" });
        const off = renderStudioHtml({ basePath: "/", scriptSrc: "/studio.js", styleHref: "/styles.css" });

        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        expect(runAs).toContain("window.__CIRRUS_RUN_AS_IDENTITY__=true;");
        expect(off).not.toContain("__CIRRUS_RUN_AS_IDENTITY__");
    });

    it("injects the rules flag only when rulesInstalled is explicitly false", () => {
        expect.assertions(3);

        const missing = renderStudioHtml({ basePath: "/", rulesInstalled: false, scriptSrc: "/studio.js", styleHref: "/styles.css" });
        const installed = renderStudioHtml({ basePath: "/", rulesInstalled: true, scriptSrc: "/studio.js", styleHref: "/styles.css" });
        const unset = renderStudioHtml({ basePath: "/", scriptSrc: "/studio.js", styleHref: "/styles.css" });

        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        expect(missing).toContain("window.__CIRRUS_RULES_INSTALLED__=false;");
        // Installed and unset both leave the global off, so the studio shows no banner.
        expect(installed).not.toContain("__CIRRUS_RULES_INSTALLED__");
        expect(unset).not.toContain("__CIRRUS_RULES_INSTALLED__");
    });

    it("injects the admin token when provided, escaping `<` for safe inline embedding", () => {
        expect.assertions(2);

        const html = renderStudioHtml({ adminToken: "tok<en", basePath: "/", scriptSrc: "/studio.js", styleHref: "/styles.css" });

        // `<` is escaped to its `\u003c` form so it cannot close the inline <script> early.
        expect(html).toContain(String.raw`"tok\u003cen"`);
        expect(html).not.toContain("tok<en");
    });
});
