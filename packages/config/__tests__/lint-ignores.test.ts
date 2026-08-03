import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLintIgnores, detectLintTools, LUNORA_IGNORED_PATHS } from "../src/lint-ignores";

let workdir: string;

const writeManifest = (dependencies: Record<string, string>): void => {
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ devDependencies: dependencies, name: "app" }, undefined, 2), "utf8");
};

const readJson = (name: string): Record<string, unknown> => parseJsonc(readFileSync(join(workdir, name), "utf8")) as Record<string, unknown>;

describe("detectLintTools", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-lint-ignores-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("finds a tool from its dependency alone", () => {
        expect.assertions(1);

        // A dependency with no config yet is a tool about to be configured.
        writeManifest({ "@biomejs/biome": "^2.0.0", prettier: "^3.0.0" });

        expect(detectLintTools(workdir)).toStrictEqual(["biome", "prettier"]);
    });

    it("finds a tool from its config file alone", () => {
        expect.assertions(1);

        // No manifest entry: the binary is global, or hoisted from a monorepo
        // root this project root cannot see. The config proves it is in use.
        writeManifest({});
        writeFileSync(join(workdir, "eslint.config.mjs"), "export default [];\n", "utf8");
        writeFileSync(join(workdir, ".oxlintrc.json"), "{}\n", "utf8");

        expect(detectLintTools(workdir)).toStrictEqual(["eslint", "oxlint"]);
    });

    it("treats a package.json prettier key as a prettier config", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "app", prettier: { semi: false } }), "utf8");

        expect(detectLintTools(workdir)).toStrictEqual(["prettier"]);
    });

    it("finds nothing in a project with neither", () => {
        expect.assertions(1);

        writeManifest({});

        expect(detectLintTools(workdir)).toStrictEqual([]);
    });
});

describe("applyLintIgnores", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-lint-apply-"));
        writeManifest({});
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("creates .prettierignore, then appends nothing on a re-run", () => {
        expect.assertions(8);

        const [created] = applyLintIgnores(workdir, ["prettier"]);

        expect(created?.status).toBe("created");

        const first = readFileSync(join(workdir, ".prettierignore"), "utf8");

        for (const entry of LUNORA_IGNORED_PATHS) {
            expect(first).toContain(entry);
        }

        // Idempotence is the property that matters: `lunora add` re-runs this on
        // every feature install, and a duplicating writer would grow the file
        // without bound.
        const [again] = applyLintIgnores(workdir, ["prettier"]);

        expect(again?.status).toBe("unchanged");
        expect(readFileSync(join(workdir, ".prettierignore"), "utf8")).toBe(first);
    });

    it("preserves a project's own .prettierignore rules", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, ".prettierignore"), "dist\n*.snap\n", "utf8");

        applyLintIgnores(workdir, ["prettier"]);

        const text = readFileSync(join(workdir, ".prettierignore"), "utf8");

        expect(text).toContain("*.snap");
        expect(text).toContain("lunora/_generated/");
    });

    it("writes oxlint's ignorePatterns, the key its schema actually declares", () => {
        expect.assertions(2);

        applyLintIgnores(workdir, ["oxlint"]);

        const config = readJson(".oxlintrc.json");

        expect(config["ignorePatterns"]).toStrictEqual([...LUNORA_IGNORED_PATHS]);
        // No `.eslintignore` anywhere — flat-config ESLint warns about that file
        // and ignores its contents, so writing one would be worse than nothing.
        expect(existsSync(join(workdir, ".eslintignore"))).toBe(false);
    });

    it("uses biome's negated includes, seeded with ** so the negations subtract from something", () => {
        expect.assertions(2);

        applyLintIgnores(workdir, ["biome"]);

        const files = readJson("biome.json")["files"] as { includes: string[] };

        expect(files.includes[0]).toBe("**");
        expect(files.includes).toContain("!lunora/_generated/**");
    });

    it("follows biome v1's files.ignore when the config already uses it", () => {
        expect.assertions(2);

        // Rather than sniff a Biome version, follow the key the project already
        // uses — that IS the version's answer, stated by the project.
        writeFileSync(join(workdir, "biome.json"), JSON.stringify({ files: { ignore: ["dist"] } }, undefined, 2), "utf8");

        applyLintIgnores(workdir, ["biome"]);

        const files = readJson("biome.json")["files"] as { ignore: string[] };

        expect(files.ignore).toContain("dist");
        expect(files.ignore).toContain("lunora/_generated/");
    });

    it("creates a flat eslint config when the project has none, as .mjs", () => {
        expect.assertions(4);

        const [outcome] = applyLintIgnores(workdir, ["eslint"]);

        expect(outcome?.status).toBe("created");

        const text = readFileSync(join(workdir, "eslint.config.mjs"), "utf8");

        expect(text).toContain("ignores:");
        expect(text).toContain('"lunora/_generated/**"');
        // The body is ESM. A `.js` config in a package without `"type": "module"`
        // is loaded as CommonJS, and ESLint dies on `Unexpected token 'export'`.
        expect(existsSync(join(workdir, "eslint.config.js"))).toBe(false);
    });

    it("refuses to rewrite an existing eslint config, and hands back the snippet", () => {
        expect.assertions(3);

        // An eslint config is arbitrary JavaScript. Editing one on the user's
        // behalf is not something to do quietly, so report it instead.
        const original = "import js from '@eslint/js';\nexport default [js.configs.recommended];\n";

        writeFileSync(join(workdir, "eslint.config.js"), original, "utf8");

        const [outcome] = applyLintIgnores(workdir, ["eslint"]);

        expect(outcome?.status).toBe("manual");
        expect(outcome?.snippet).toContain("ignores:");
        expect(readFileSync(join(workdir, "eslint.config.js"), "utf8")).toBe(original);
    });

    it("never shadows a monorepo root config by creating a nested one", () => {
        expect.assertions(6);

        // The damaging case. In a workspace the dependency is declared in the
        // package while the config lives at the root, and `detectLintTools` fires
        // on the dependency alone. Creating a package-level config here does not
        // add ignores — it SHADOWS the root: ESLint 9 stops at the first flat
        // config walking up, so a file holding only `ignores` and no rules
        // silently switches off everything the root enforced, and lint exits 0.
        // Biome and oxlint replace an outer rule set the same way.
        mkdirSync(join(workdir, ".git"), { recursive: true });
        writeFileSync(join(workdir, "eslint.config.mjs"), "export default [];\n", "utf8");
        writeFileSync(join(workdir, "biome.json"), "{}\n", "utf8");
        writeFileSync(join(workdir, ".oxlintrc.json"), "{}\n", "utf8");

        const packageDirectory = join(workdir, "apps", "web");

        mkdirSync(packageDirectory, { recursive: true });
        writeFileSync(
            join(packageDirectory, "package.json"),
            JSON.stringify({ devDependencies: { "@biomejs/biome": "^2", eslint: "^9", oxlint: "^1" } }),
            "utf8",
        );

        const outcomes = applyLintIgnores(packageDirectory, ["biome", "eslint", "oxlint"]);

        for (const outcome of outcomes) {
            expect(outcome.status).toBe("manual");
        }

        expect(existsSync(join(packageDirectory, "eslint.config.mjs"))).toBe(false);
        expect(existsSync(join(packageDirectory, "biome.json"))).toBe(false);
        expect(existsSync(join(packageDirectory, ".oxlintrc.json"))).toBe(false);
    });

    it("stops the upward search at the repository boundary", () => {
        expect.assertions(2);

        // Without a boundary a project nested anywhere under a developer's home
        // directory could bind to an unrelated config far above it.
        writeFileSync(join(workdir, "eslint.config.mjs"), "export default [];\n", "utf8");

        const repository = join(workdir, "repo");

        mkdirSync(join(repository, ".git"), { recursive: true });
        writeFileSync(join(repository, "package.json"), JSON.stringify({ devDependencies: { eslint: "^9" } }), "utf8");

        const [outcome] = applyLintIgnores(repository, ["eslint"]);

        expect(outcome?.status).toBe("created");
        expect(existsSync(join(repository, "eslint.config.mjs"))).toBe(true);
    });

    it("still extends a config that lives in the project directory itself", () => {
        expect.assertions(2);

        // The shadowing guard must not block the ordinary single-repo case.
        writeFileSync(join(workdir, ".oxlintrc.json"), JSON.stringify({ rules: { eqeqeq: "error" } }, undefined, 2), "utf8");

        const [outcome] = applyLintIgnores(workdir, ["oxlint"]);

        expect(outcome?.status).toBe("updated");
        expect(readJson(".oxlintrc.json")["ignorePatterns"]).toStrictEqual([...LUNORA_IGNORED_PATHS]);
    });

    it("reports an existing eslint config that already lists the paths as unchanged", () => {
        expect.assertions(1);

        const ignores = LUNORA_IGNORED_PATHS.map((entry) => `"${entry}"`).join(", ");

        writeFileSync(join(workdir, "eslint.config.js"), `export default [{ ignores: [${ignores}] }];\n`, "utf8");

        expect(applyLintIgnores(workdir, ["eslint"])[0]?.status).toBe("unchanged");
    });
});
