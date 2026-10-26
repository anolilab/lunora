import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { sideEffects } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { sideEffects?: unknown };

const scratch = mkdtempSync(join(tmpdir(), "lunorash-side-effects-"));

const writePackage = (name: string, source: string, packageSideEffects: unknown = false): void => {
    const directory = join(scratch, "node_modules", name);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ exports: "./index.mjs", name, sideEffects: packageSideEffects, type: "module" }));
    writeFileSync(join(directory, "index.mjs"), source);
};

/**
 * Every umbrella entry is a bare `export * from "@lunora/<pkg>"`. When the package it
 * re-exports is ALSO reachable through an `import()` (the lazy function registry, the
 * generated app's deferred `@lunora/auth`), esbuild wraps that package in a lazy-init
 * function, and with the umbrella marked `"sideEffects": false` it drops the init call
 * at the static `export *` site: the Worker then dies at startup reading a binding
 * that was never assigned. Modelled here with stand-in packages that carry the
 * umbrella's real `sideEffects` value.
 */
describe("lunorash — sideEffects", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("keeps a re-exported package initialised when it is also imported lazily", async () => {
        expect.assertions(1);

        writePackage("inner", "export const builders = { make: () => 1 };\n");
        writePackage("umbrella", 'export * from "inner";\n', sideEffects);
        writePackage("lazy", 'import { builders } from "inner";\nexport const heavy = () => builders.make();\n');
        writeFileSync(
            join(scratch, "entry.mjs"),
            'import { builders } from "umbrella";\nexport const made = builders.make();\nexport const load = () => import("lazy");\n',
        );

        const outfile = join(scratch, "out.mjs");

        await build({ absWorkingDir: scratch, bundle: true, entryPoints: ["entry.mjs"], format: "esm", logLevel: "silent", outfile });

        const module = (await import(pathToFileURL(outfile).href)) as { made: number };

        expect(module.made).toBe(1);
    });
});
