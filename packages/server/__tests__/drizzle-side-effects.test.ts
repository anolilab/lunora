import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { sideEffects } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { sideEffects?: unknown };

const scratch = mkdtempSync(join(tmpdir(), "lunora-server-drizzle-side-effects-"));

const writePackage = (name: string, file: string, source: string, packageSideEffects: unknown = false): void => {
    const directory = join(scratch, "node_modules", name);

    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ exports: `./${file}`, name, sideEffects: packageSideEffects, type: "module" }));
    writeFileSync(join(directory, file), source);
};

/**
 * `@lunora/server/drizzle` is a bare `export * from "drizzle-orm/sqlite-core"`. When
 * drizzle is ALSO reachable through an `import()` (the lazy function registry, the
 * generated app's deferred auth module), esbuild wraps it in a lazy-init function and,
 * if this file is marked side-effect free, drops the init call at the static
 * `export *` site, so the Worker dies at startup. Modelled with stand-in packages that
 * carry this package's real `sideEffects` value at the same file path.
 */
describe("@lunora/server/drizzle — sideEffects", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("keeps the re-exported drizzle surface initialised when drizzle is also imported lazily", async () => {
        expect.assertions(1);

        writePackage("inner", "index.mjs", "export const sqliteTable = () => 1;\n");
        writePackage("server", "dist/drizzle.mjs", 'export * from "inner";\n', sideEffects);
        writePackage("lazy", "index.mjs", 'import { sqliteTable } from "inner";\nexport const heavy = () => sqliteTable();\n');
        writeFileSync(
            join(scratch, "entry.mjs"),
            'import { sqliteTable } from "server";\nexport const made = sqliteTable();\nexport const load = () => import("lazy");\n',
        );

        const outfile = join(scratch, "out.mjs");

        await build({ absWorkingDir: scratch, bundle: true, entryPoints: ["entry.mjs"], format: "esm", logLevel: "silent", outfile });

        const module = (await import(pathToFileURL(outfile).href)) as { made: number };

        expect(module.made).toBe(1);
    });
});
