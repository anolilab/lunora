import { describe, expect, it } from "vitest";

import { assetContentType, isStandaloneModulePath, resolveContainedFile } from "../../src/studio-host/assets";

// A representative absolute standalone directory (as `@lunora/studio`'s
// `dist/standalone` would resolve to). The guard is pure path math, so a fixed
// root exercises it without touching the filesystem.
const DIR = "/srv/app/node_modules/@lunora/studio/dist/standalone";

describe("resolveContainedFile (studio standalone path-traversal guard)", () => {
    it("resolves a plain entry / chunk / map filename to a direct child of the dir", () => {
        expect.assertions(3);

        expect(resolveContainedFile(DIR, "studio.js")).toBe(`${DIR}/studio.js`);
        expect(resolveContainedFile(DIR, "chunk-FQKNJSRA.js")).toBe(`${DIR}/chunk-FQKNJSRA.js`);
        expect(resolveContainedFile(DIR, "studio.js.map")).toBe(`${DIR}/studio.js.map`);
    });

    it("rejects traversal, absolute escapes, nested paths, and control chars", () => {
        expect.assertions(11);

        // Anything that could read outside the standalone directory must resolve
        // to `undefined` (the host then answers 404) — never a path outside `DIR`.
        const rejected = [
            "",
            ".",
            "..",
            "../styles.css",
            "../../etc/passwd",
            "../../../../../../etc/passwd",
            "/etc/passwd",
            "foo/bar.js",
            String.raw`a\b.js`,
            "sub/chunk.js",
            "chunk\0.js",
        ];

        for (const name of rejected) {
            expect(resolveContainedFile(DIR, name)).toBeUndefined();
        }
    });
});

describe("isStandaloneModulePath", () => {
    it("matches the studio.js entry, chunks, and their maps — not the stylesheet or SPA routes", () => {
        expect.assertions(6);

        expect(isStandaloneModulePath("/studio.js")).toBe(true);
        expect(isStandaloneModulePath("/__lunora/chunk-FQKNJSRA.js")).toBe(true);
        expect(isStandaloneModulePath("/studio.js.map")).toBe(true);
        expect(isStandaloneModulePath("/styles.css")).toBe(false);
        expect(isStandaloneModulePath("/__lunora/data")).toBe(false);
        expect(isStandaloneModulePath("/")).toBe(false);
    });
});

describe("assetContentType", () => {
    it("maps each served extension to its Content-Type", () => {
        expect.assertions(4);

        expect(assetContentType("styles.css")).toBe("text/css; charset=utf-8");
        expect(assetContentType("studio.js.map")).toBe("application/json; charset=utf-8");
        expect(assetContentType("studio.js")).toBe("text/javascript; charset=utf-8");
        expect(assetContentType("chunk-ABCD1234.js")).toBe("text/javascript; charset=utf-8");
    });
});
