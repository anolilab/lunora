import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

import { defineConfig } from "@anolilab/lint-staged-config";

// Examples are standalone apps requiring their own `pnpm install` before
// type-checking works; exclude them from lint-staged TypeScript checks.
const config = defineConfig({ typescript: { exclude: ["/examples/", "/apps/web/"], extensions: ["cts", "ts", "mts", "tsx", "ctsx"] } });

// Exclude Playwright e2e spec files from being run through vitest.
// These files use Playwright's test.describe() which is incompatible with vitest.
// Exclude __fixtures__ directories from sort-package-json — they may contain
// intentionally malformed JSON used by tests.
const FIXTURES_PATH_PATTERN = /__fixtures__[/\\]/;
const originalPkgHandler = config["**/package.json"];

if (originalPkgHandler) {
    config["**/package.json"] = (files) => {
        const filtered = files.filter((f) => !FIXTURES_PATH_PATTERN.test(f));

        if (filtered.length === 0) {
            return [];
        }

        if (Array.isArray(originalPkgHandler)) {
            return originalPkgHandler.map((cmd) => `${cmd} ${filtered.join(" ")}`);
        }

        return originalPkgHandler(filtered);
    };
}

// Prettier-format staged Markdown / MDX at commit time. Every
// package's `lint:prettier` already covers `docs/` via `--check .`,
// but nothing enforced it on commit, so docs could silently drift out
// of compliance (vis/docs did). Prettier resolves each file's nearest
// `prettier.config.js` itself. CHANGELOG.md is prettier-ignored
// repo-wide; __fixtures__ may hold intentionally malformed content.
config["**/*.{md,mdx}"] = (files) => {
    const filtered = files.filter((f) => !FIXTURES_PATH_PATTERN.test(f) && !/[/\\]CHANGELOG\.md$/.test(f));

    if (filtered.length === 0) {
        return [];
    }

    return [`pnpm exec prettier --write ${filtered.map((f) => JSON.stringify(f)).join(" ")}`];
};

const E2E_PATH_PATTERN = /__tests__[/\\]e2e[/\\]/;

// Group staged test files by their owning package and run vitest from that
// package's directory (via `pnpm --filter <name>`). The upstream shared config
// emits a single `vitest related --run <abs paths>` command that runs from the
// repo root — but the root `vitest.config.ts` is intentionally minimal and
// doesn't load per-package setup files, so custom matchers (e.g.
// `toMatchStackFrame` in @visulima/error) report as "Invalid Chai property".
// Filtering through pnpm restores the per-package config + setup.
const VITEST_TEST_PATTERN = "**/?(*.){test,spec}.?(c|m)[jt]s?(x)";
const VITEST_TESTS_DIR_PATTERN = "**/__tests__/**/*.?(c|m)[jt]s?(x)";

const findOwningPackage = (file) => {
    let dir = dirname(file);

    while (dir.length > 1 && dir !== sep) {
        const pkgJsonPath = `${dir}/package.json`;

        if (existsSync(pkgJsonPath) && existsSync(`${dir}/vitest.config.ts`)) {
            try {
                const { name } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

                if (typeof name === "string" && name.length > 0) {
                    return { name, root: dir };
                }
            } catch {
                return null;
            }
        }

        dir = dirname(dir);
    }

    return null;
};

const groupVitestFilesByPackage = (files) => {
    const groups = new Map();

    for (const file of files) {
        const owner = findOwningPackage(file);

        if (!owner) {
            continue;
        }

        if (!groups.has(owner.name)) {
            groups.set(owner.name, { files: [], root: owner.root });
        }

        groups.get(owner.name).files.push(file);
    }

    return groups;
};

const vitestPerPackage = (files) => {
    const filtered = files.filter((f) => !E2E_PATH_PATTERN.test(f));

    if (filtered.length === 0) {
        return [];
    }

    const groups = groupVitestFilesByPackage(filtered);

    if (groups.size === 0) {
        return [];
    }

    const commands = [];

    for (const [pkgName, { files: pkgFiles, root }] of groups) {
        const rels = pkgFiles.map((f) => JSON.stringify(relative(root, f))).join(" ");

        commands.push(`pnpm --filter ${JSON.stringify(pkgName)} exec vitest related --run ${rels}`);
    }

    return commands;
};

config[VITEST_TEST_PATTERN] = vitestPerPackage;
config[VITEST_TESTS_DIR_PATTERN] = vitestPerPackage;

export default config;
