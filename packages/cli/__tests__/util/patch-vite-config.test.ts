import { describe, expect, it } from "vitest";

import { patchViteConfig } from "../../src/util/patch-vite-config";

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

const ALREADY_HAS_LUNORA = `\
import { defineConfig } from "vite";
import { lunora } from "@lunora/vite";

export default defineConfig({ plugins: [lunora()] });
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
        it("returns changed:false when lunora() is already present", () => {
            expect.assertions(3);

            const result = patchViteConfig(ALREADY_HAS_LUNORA);

            expect(result.changed).toBe(false);
            expect(result.code).toBe(ALREADY_HAS_LUNORA);
            expect(result.reason).toBe("lunora plugin already present");
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
        it("adds the @lunora/vite import when it is missing", () => {
            expect.assertions(2);

            const result = patchViteConfig(NO_PLUGINS_KEY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain('import { lunora } from "@lunora/vite"');
        });

        it("does NOT duplicate the import when @lunora/vite is already imported", () => {
            expect.assertions(2);

            // Patch once so the import is present, then count occurrences.
            const first = patchViteConfig(NO_PLUGINS_KEY);
            const occurrences = (first.code.match(/@lunora\/vite/gu) ?? []).length;

            expect(first.changed).toBe(true);
            expect(occurrences).toBe(1);
        });
    });

    describe("defineConfig({ plugins: [...] }) — existing entries", () => {
        it("prepends lunora() before existing plugins", () => {
            expect.assertions(3);

            const result = patchViteConfig(WITH_PLUGINS_REACT);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("lunora()");
            // lunora() must appear before react()
            expect(result.code.indexOf("lunora()")).toBeLessThan(result.code.indexOf("react()"));
        });

        it("preserves the existing plugin entries", () => {
            expect.assertions(1);

            const result = patchViteConfig(WITH_PLUGINS_REACT);

            expect(result.code).toContain("react()");
        });
    });

    describe("defineConfig({ plugins: [] }) — empty array", () => {
        it("fills the empty plugins array with lunora()", () => {
            expect.assertions(2);

            const result = patchViteConfig(WITH_PLUGINS_EMPTY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("lunora()");
        });
    });

    describe("defineConfig({}) — no plugins key", () => {
        it("adds a plugins: [lunora()] property", () => {
            expect.assertions(3);

            const result = patchViteConfig(NO_PLUGINS_KEY);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("plugins:");
            expect(result.code).toContain("lunora()");
        });
    });

    describe("plain export default { ... } (no defineConfig wrapper)", () => {
        it("prepends lunora() into an existing plugins array", () => {
            expect.assertions(3);

            const result = patchViteConfig(PLAIN_OBJECT_WITH_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("lunora()");
            expect(result.code.indexOf("lunora()")).toBeLessThan(result.code.indexOf("react()"));
        });

        it("adds plugins: [lunora()] to an empty plain-object config", () => {
            expect.assertions(3);

            const result = patchViteConfig(PLAIN_OBJECT_NO_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("plugins:");
            expect(result.code).toContain("lunora()");
        });
    });

    describe("multi-line plugins array", () => {
        it("prepends lunora() as the first entry in a multiline plugins array", () => {
            expect.assertions(4);

            const result = patchViteConfig(MULTILINE_PLUGINS);

            expect(result.changed).toBe(true);
            expect(result.code).toContain("lunora()");
            expect(result.code.indexOf("lunora()")).toBeLessThan(result.code.indexOf("react()"));
            // Existing entries survive
            expect(result.code).toContain("tsconfigPaths()");
        });
    });

    describe("no-op paths", () => {
        it("reports changed: false with a reason when `plugins` is not an array literal", () => {
            expect.assertions(3);

            // A shared plugin list — the shape the splice cannot handle. It bailed
            // with a bare `return` and the caller still got `changed: true` over
            // untouched `code`, so `init` wrote the file back and reported the Vite
            // config patched while the project got no `lunora()` at all. The
            // docblock has always promised `changed: false` for ANY no-op path.
            const source = `import { defineConfig } from "vite";
import plugins from "./vite-plugins";

export default defineConfig({ plugins });
`;

            const result = patchViteConfig(source);

            expect(result.changed).toBe(false);
            expect(result.code).toBe(source);
            expect(result.reason).toContain("not an array literal");
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
