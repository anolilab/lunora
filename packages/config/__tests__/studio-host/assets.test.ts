import { describe, expect, it } from "vitest";

import { resolveContainedFile } from "../../src/studio-host/assets";

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
