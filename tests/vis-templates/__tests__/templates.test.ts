import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Static validation of the whole-project scaffolds under `templates/*`.
 *
 * These templates are NOT workspace members (their `package.json` `name` is the
 * `{{name}}` placeholder and their `@cirrus/*` deps are the `^0.0.0` registry
 * contract, not `workspace:*`), so pnpm never installs or type-checks them
 * in-repo. This suite is the guardrail that replaces that: it reads every
 * `templates/<framework>/package.json` and asserts the invariants that would
 * otherwise silently drift —
 *
 *  1. the `{{name}}` placeholder + `private: true` contract,
 *  2. every `@cirrus/*` dependency names a package that actually exists under
 *     `packages/` (catches a renamed/dropped package or a typo'd scope),
 *  3. `@cirrus/*` deps use the `^0.0.0` contract (never `workspace:*` — a
 *     rendered template is a standalone app that installs from the registry),
 *  4. each template depends on the Cirrus client adapter its framework needs,
 *  5. external framework deps track the latest supported MAJOR (the manifest
 *     below) — so a template can't quietly fall a major behind the ecosystem.
 *
 * When a framework ships a new major and a template is upgraded, bump the
 * matching entry in {@link LATEST_MAJORS}; the test then enforces it everywhere.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    name?: string;
    private?: boolean;
}

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;

const listDirectories = (parent: string): string[] =>
    readdirSync(parent)
        .filter((entry) => !entry.startsWith("."))
        .filter((entry) => statSync(join(parent, entry)).isDirectory());

/** Real `@cirrus/*` package names discovered from `packages/<dir>/package.json`. */
const realCirrusPackages = new Set(
    listDirectories(PACKAGES_DIR)
        .map((dir) => readJson(join(PACKAGES_DIR, dir, "package.json")).name)
        .filter((name): name is string => typeof name === "string" && name.startsWith("@cirrus/")),
);

const templateNames = listDirectories(TEMPLATES_DIR);

/** All deps (prod + dev) of a template's package.json, merged. */
const allDeps = (pkg: PackageJson): Record<string, string> => ({ ...pkg.dependencies, ...pkg.devDependencies });

/**
 * Parse the leading major from a caret/tilde range like `^6.3.0` or `~4.99.0`.
 * Returns `null` for ranges we don't enforce a major on (e.g. `^0.x` libs whose
 * 0-majors aren't semver-stable, or OR-ranges).
 */
const leadingMajor = (range: string): number | null => {
    const match = /^[\^~]?(\d+)\./.exec(range.trim());

    if (!match) {
        return null;
    }

    return Number(match[1]);
};

/**
 * Latest supported MAJOR per external framework dep. The source of truth for
 * "templates are on the latest framework versions". Bump an entry here in the
 * same change that upgrades the template(s) that use it.
 *
 * Deps whose stable line is still `0.x` (vinxi, nitro-cloudflare-dev,
 * @solidjs/router) are intentionally omitted — a 0-major bump isn't a
 * compatibility signal worth gating in CI.
 */
const LATEST_MAJORS: Record<string, number> = {
    "@astrojs/cloudflare": 13,
    "@astrojs/react": 5,
    "@cloudflare/workers-types": 4,
    "@react-router/dev": 7,
    "@solidjs/start": 1,
    "@sveltejs/adapter-cloudflare": 7,
    "@sveltejs/kit": 2,
    "@sveltejs/vite-plugin-svelte": 7,
    "@tanstack/react-query": 5,
    "@tanstack/react-router": 1,
    "@tanstack/react-start": 1,
    "@tanstack/router-plugin": 1,
    "@vitejs/plugin-react": 6,
    astro: 6,
    isbot: 5,
    nuxt: 4,
    react: 19,
    "react-dom": 19,
    "react-router": 7,
    "solid-js": 1,
    svelte: 5,
    vite: 8,
    "vite-tsconfig-paths": 6,
    vue: 3,
    wrangler: 4,
};

/**
 * The Cirrus client adapter each template's UI must depend on. `standalone` has
 * no UI (server-only), so it's exempt.
 */
const REQUIRED_ADAPTER: Record<string, string | null> = {
    astro: "@cirrus/react",
    nuxt: "@cirrus/vue",
    "react-router": "@cirrus/react",
    "solid-start": "@cirrus/solid",
    standalone: null,
    sveltekit: "@cirrus/svelte",
    "tanstack-start": "@cirrus/react",
    vite: "@cirrus/react",
};

describe("templates/* package.json validation", () => {
    test("there is at least one template", () => {
        expect(templateNames.length).toBeGreaterThan(0);
    });

    describe.each(templateNames)("templates/%s", (templateName) => {
        const pkg = readJson(join(TEMPLATES_DIR, templateName, "package.json"));
        const deps = allDeps(pkg);

        test("uses the {{name}} placeholder and is private", () => {
            expect(pkg.name).toBe("{{name}}");
            expect(pkg.private).toBe(true);
        });

        test("every @cirrus/* dependency names a real package", () => {
            const cirrusDeps = Object.keys(deps).filter((name) => name.startsWith("@cirrus/"));

            // Every template wires at least @cirrus/runtime + @cirrus/server.
            expect(cirrusDeps).toContain("@cirrus/runtime");
            expect(cirrusDeps).toContain("@cirrus/server");

            for (const name of cirrusDeps) {
                expect(realCirrusPackages, `${templateName} references unknown package ${name}`).toContain(name);
            }
        });

        test("@cirrus/* deps use the ^0.0.0 registry contract, never workspace:*", () => {
            for (const [name, range] of Object.entries(deps)) {
                if (!name.startsWith("@cirrus/")) {
                    continue;
                }

                expect(range, `${templateName} → ${name}`).toBe("^0.0.0");
            }
        });

        test("depends on the framework's Cirrus client adapter", () => {
            const adapter = REQUIRED_ADAPTER[templateName];

            // A new template must be added to REQUIRED_ADAPTER (even as null) so
            // this guard is a conscious decision, not an accidental skip.
            expect(REQUIRED_ADAPTER, `add ${templateName} to REQUIRED_ADAPTER`).toHaveProperty(templateName);

            if (adapter !== null) {
                expect(Object.keys(deps)).toContain(adapter);
            }
        });

        test("external framework deps are on the latest supported major", () => {
            for (const [name, range] of Object.entries(deps)) {
                if (name.startsWith("@cirrus/")) {
                    continue;
                }

                const expectedMajor = LATEST_MAJORS[name];

                if (expectedMajor === undefined) {
                    continue;
                }

                const actualMajor = leadingMajor(range);

                expect(actualMajor, `${templateName} → ${name} (${range}) has an unparseable range`).not.toBeNull();
                expect(actualMajor, `${templateName} → ${name} is on major ${actualMajor}, expected ${expectedMajor}`).toBe(expectedMajor);
            }
        });
    });
});
