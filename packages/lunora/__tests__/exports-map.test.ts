import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    exports: Record<string, string | { import: string; types: string }>;
    main: string;
    module: string;
    types: string;
};

const conditionalEntries = Object.entries(packageJson.exports).filter(
    (entry): entry is [string, { import: string; types: string }] => typeof entry[1] === "object",
);

// The exports map is the umbrella's whole product: a subpath that points at a
// missing dist file (a packem entry dropped, a renamed source) publishes a
// broken package that installs fine and explodes on first import. These
// manifest tests hold the map, the built dist, and the sources together.
describe("package.json exports-map integrity", () => {
    it("declares every expected subpath", () => {
        const subpaths = Object.keys(packageJson.exports);

        // Load-bearing subpaths: codegen emits imports against these when a
        // project depends on the umbrella, so removing one breaks generated code.
        for (const required of [".", "./server", "./values", "./runtime", "./do", "./client", "./errors", "./flags", "./package.json"]) {
            expect(subpaths).toContain(required);
        }
    });

    it.each(conditionalEntries)("%s resolves to real files in dist", (subpath, entry) => {
        expect(existsSync(join(packageRoot, entry.import)), `${subpath}: missing ${entry.import}`).toBe(true);
        expect(existsSync(join(packageRoot, entry.types)), `${subpath}: missing ${entry.types}`).toBe(true);
    });

    it.each(conditionalEntries)("%s dynamically imports without throwing", async (subpath) => {
        // Type-only subpaths (e.g. ./server/data-model) legitimately export
        // nothing at runtime — the load-bearing check is that the specifier
        // resolves and the module evaluates.
        const specifier = subpath === "." ? "lunorash" : `lunorash/${subpath.slice(2)}`;

        await expect(import(specifier)).resolves.toBeDefined();
    });

    it.each(conditionalEntries)("%s has a matching source entry module", (subpath) => {
        // packem derives dist entries from src/: every declared subpath must map
        // back to src/<subpath>.ts (the "." root maps to src/index.ts).
        const sourcePath = subpath === "." ? "src/index.ts" : `src/${subpath.slice(2)}.ts`;

        expect(existsSync(join(packageRoot, sourcePath)), `${subpath}: missing ${sourcePath}`).toBe(true);
    });

    it("keeps the top-level main/module/types aligned with the '.' export", () => {
        const root = packageJson.exports["."] as { import: string; types: string };

        expect(packageJson.main).toBe(root.import);
        expect(packageJson.module).toBe(root.import);
        expect(packageJson.types).toBe(root.types);
    });
});

describe("lunora bin delegation", () => {
    it("ships the lunora bin pointing at a real, shebanged entry", () => {
        expect(packageJson.bin).toStrictEqual({ lunora: "./dist/bin.mjs" });

        const binPath = join(packageRoot, packageJson.bin.lunora as string);

        expect(existsSync(binPath)).toBe(true);
        // Without the node shebang the installed bin is spawned by the shell and
        // dies on the first import statement.
        expect(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    });

    it("delegates to @lunora/cli's runCli rather than carrying its own CLI", () => {
        const source = readFileSync(join(packageRoot, "src/bin.ts"), "utf8");

        expect(source).toContain('import { runCli } from "@lunora/cli"');
        expect(source).toContain("await runCli()");
    });
});
