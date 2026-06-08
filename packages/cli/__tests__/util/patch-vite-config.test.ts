import { describe, expect, it } from "vitest";

import { patchViteConfig } from "../../src/util/patch-vite-config.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WITH_PLUGINS_REACT = `\
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
`;

const WITH_PLUGINS_EMPTY = `\
import { defineConfig } from "vite";

export default defineConfig({ plugins: [] });
`;

const NO_PLUGINS_KEY = `\
import { defineConfig } from "vite";

export default defineConfig({});
`;

const PLAIN_OBJECT_WITH_PLUGINS = `\
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default { plugins: [react()] };
`;

const PLAIN_OBJECT_NO_PLUGINS = `\
import { defineConfig } from "vite";

export default {};
`;

const ALREADY_HAS_CIRRUS = `\
import { defineConfig } from "vite";
import { cirrus } from "@cirrus/vite";

export default defineConfig({ plugins: [cirrus()] });
`;

const NO_RECOGNISABLE_EXPORT = `\
const config = { plugins: [] };
module.exports = config;
`;

const MULTILINE_PLUGINS = `\
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [
        react(),
        tsconfigPaths(),
    ],
});
`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("patchViteConfig", () => {
    describe("idempotency", () => {
        it("returns changed:false when cirrus() is already present", () => {
            expect.assertions(3);

            const result = patchViteConfig(ALREADY_HAS_CIRRUS);

            expect(result.changed).toBe(false);
            expect(result.code).toBe(ALREADY_HAS_CIRRUS);
            expect(result.reason).toBe("cirrus plugin already present");
        });

        it("is idempotent when called twice on the same source", () => {
            expect.assertions(2);

            const first = patchViteConfig(WITH_PLUGINS_REACT);

            expect(first.changed).toBe(true);

            const second = patchViteConfig(first.code);

            expect(second.changed).toBe(false);
        });
    });

    describe("no-recognisable-config guard", () => {
        it("returns changed:false with reason when no Vite config shape found", () => {
            expect.assertions(3);

            const result = patchViteConfig(NO_RECOGNISABLE_EXPORT);

            expect(result.changed).toBe(false);
            expect(result.code).toBe(NO_RECOGNISABLE_EXPORT);
            expect(result.reason).toContain("could not locate");
        });
    });

    describe("import injection", () => {
        it("adds the @cirrus/vite import when it is missing", () => {
            expect.assertions(2);

            const result = patchViteConfig(NO_PLUGINS_KEY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain('import { cirrus } from "@cirrus/vite"');
        });

        it("does NOT duplicate the import when @cirrus/vite is already imported", () => {
            expect.assertions(2);

            // Patch once so the import is present, then count occurrences.
            const first = patchViteConfig(NO_PLUGINS_KEY);
            const occurrences = (first.code.match(/@cirrus\/vite/gu) ?? []).length;

            expect(first.changed).toBe(true);
            expect(occurrences).toBe(1);
        });
    });

    describe("defineConfig({ plugins: [...] }) — existing entries", () => {
        it("prepends cirrus() before existing plugins", () => {
            expect.assertions(3);

            const result = patchViteConfig(WITH_PLUGINS_REACT);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("cirrus()");
            // cirrus() must appear before react()
            expect(result.code.indexOf("cirrus()")).toBeLessThan(result.code.indexOf("react()"));
        });

        it("preserves the existing plugin entries", () => {
            expect.assertions(1);

            const result = patchViteConfig(WITH_PLUGINS_REACT);

            expect(result.code).toContain("react()");
        });
    });

    describe("defineConfig({ plugins: [] }) — empty array", () => {
        it("fills the empty plugins array with cirrus()", () => {
            expect.assertions(2);

            const result = patchViteConfig(WITH_PLUGINS_EMPTY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("cirrus()");
        });
    });

    describe("defineConfig({}) — no plugins key", () => {
        it("adds a plugins: [cirrus()] property", () => {
            expect.assertions(3);

            const result = patchViteConfig(NO_PLUGINS_KEY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("plugins:");
            expect(result.code).toContain("cirrus()");
        });
    });

    describe("plain export default { ... } (no defineConfig wrapper)", () => {
        it("prepends cirrus() into an existing plugins array", () => {
            expect.assertions(3);

            const result = patchViteConfig(PLAIN_OBJECT_WITH_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("cirrus()");
            expect(result.code.indexOf("cirrus()")).toBeLessThan(result.code.indexOf("react()"));
        });

        it("adds plugins: [cirrus()] to an empty plain-object config", () => {
            expect.assertions(3);

            const result = patchViteConfig(PLAIN_OBJECT_NO_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("plugins:");
            expect(result.code).toContain("cirrus()");
        });
    });

    describe("multi-line plugins array", () => {
        it("prepends cirrus() as the first entry in a multiline plugins array", () => {
            expect.assertions(4);

            const result = patchViteConfig(MULTILINE_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("cirrus()");
            expect(result.code.indexOf("cirrus()")).toBeLessThan(result.code.indexOf("react()"));
            // Existing entries survive
            expect(result.code).toContain("tsconfigPaths()");
        });
    });

    describe("output correctness", () => {
        it("produces valid-looking TypeScript (contains export default)", () => {
            expect.assertions(1);

            const result = patchViteConfig(WITH_PLUGINS_REACT);

            expect(result.code).toContain("export default");
        });

        it("does not corrupt the original source when only adding an import", () => {
            expect.assertions(1);

            const result = patchViteConfig(NO_PLUGINS_KEY);

            // The rest of the original content must still be present
            expect(result.code).toContain("defineConfig");
        });
    });
});
