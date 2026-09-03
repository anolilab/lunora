import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Static validation of the whole-project scaffolds under `templates/*`.
 *
 * These templates are NOT workspace members (their `package.json` `name` is the
 * `{{name}}` placeholder and their `@lunora/*` deps are the `^0.0.0` registry
 * contract, not `workspace:*`), so pnpm never installs or type-checks them
 * in-repo. This suite is the guardrail that replaces that: it reads every
 * `templates/<framework>/package.json` and asserts the invariants that would
 * otherwise silently drift —
 *
 *  1. the `{{name}}` placeholder + `private: true` contract,
 *  2. every Lunora dependency (the `lunora` umbrella or any `@lunora/*`) names a
 *     package that actually exists under `packages/` (catches a renamed/dropped
 *     package or a typo'd scope),
 *  3. Lunora deps use the `^0.0.0` contract (never `workspace:*` — a rendered
 *     template is a standalone app that installs from the registry),
 *  4. each template depends on the Lunora client adapter its framework needs,
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

/** A Lunora-owned dependency: the unscoped `lunorash` umbrella or any `@lunora/*` package. */
const isLunoraDep = (name: string): boolean => name === "lunorash" || name.startsWith("@lunora/");

/**
 * Real Lunora package names (the `lunorash` umbrella + every `@lunora/*`)
 * discovered from `packages/<dir>/package.json`.
 *
 * Directories without a `package.json` are skipped rather than read: `packages/`
 * routinely holds non-package residue in a working tree — a half-scaffolded
 * package, a stale `node_modules`-only leftover from an aborted install — and a
 * throw there takes down the whole suite for something that is not a package at
 * all. Skipping cannot mask a real regression either: a *renamed or deleted*
 * package still disappears from this set and still trips assertion (2).
 */
const realLunoraPackages = new Set(
    listDirectories(PACKAGES_DIR)
        .map((dir) => join(PACKAGES_DIR, dir, "package.json"))
        .filter((manifest) => existsSync(manifest))
        .map((manifest) => readJson(manifest).name)
        .filter((name): name is string => typeof name === "string" && isLunoraDep(name)),
);

const templateNames = listDirectories(TEMPLATES_DIR);

/** All deps (prod + dev) of a template's package.json, merged. */
const allDeps = (pkg: PackageJson): Record<string, string> => ({ ...pkg.dependencies, ...pkg.devDependencies });

/**
 * Parse the leading major from a single caret/tilde range like `^6.3.0`,
 * `~4.99.0`, or a bare `^7`. Returns `null` for shapes we don't enforce a major
 * on — an OR-range (`^5 || ^6`), a wildcard, or anything not starting with a
 * numeric major — so the caller can skip rather than misread it.
 */
const leadingMajor = (range: string): number | null => {
    const trimmed = range.trim();

    // OR-ranges encode multi-major support deliberately; don't pick one major.
    if (trimmed.includes("||")) {
        return null;
    }

    const match = /^[\^~]?(\d+)(?:[.\s]|$)/.exec(trimmed);

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
    // 14 is not cosmetic: 13 depends on `vite: ^7.3.2` while `astro@7` depends on
    // `vite: ^8.0.13`, so `@cloudflare/vite-plugin` resolved against a second,
    // older Vite and the build died inside workerd with `Missing field
    // \`moduleType\``. 14 moved to `vite: ^8.0.13` and peers on `astro: ^7.0.0`.
    "@astrojs/cloudflare": 14,
    "@astrojs/react": 5,
    "@cloudflare/workers-types": 4,
    "@opennextjs/cloudflare": 1,
    "@react-router/dev": 7,
    "@solidjs/start": 1,
    "@sveltejs/adapter-cloudflare": 7,
    "@sveltejs/kit": 2,
    "@sveltejs/vite-plugin-svelte": 7,
    "@tanstack/react-query": 5,
    "@tanstack/react-router": 1,
    "@tanstack/react-start": 1,
    "@tanstack/router-plugin": 1,
    "@tanstack/solid-router": 1,
    "@tanstack/solid-start": 1,
    "@vitejs/plugin-react": 6,
    astro: 7,
    isbot: 5,
    next: 16,
    nuxt: 4,
    react: 19,
    "react-dom": 19,
    "react-router": 7,
    "solid-js": 1,
    svelte: 5,
    vite: 8,
    "vite-plugin-solid": 2,
    "vite-tsconfig-paths": 6,
    vue: 3,
    wrangler: 4,
};

/**
 * Per-template major overrides — keyed by template → dep → the major it must
 * stay on. Covers a template that intentionally pins a dep *below*
 * {@link LATEST_MAJORS}, and the reverse: one that deliberately runs ahead.
 *
 * `solid-v2` is the ahead case. It exists to track the Solid 2.0 line while
 * Solid 2 is still an RC, so {@link LATEST_MAJORS} keeps `solid-js` on the
 * stable major 1 for every other template (`tanstack-start-solid` is pinned
 * there by TanStack's own peer range anyway) and this template opts forward.
 * When Solid 2 ships stable, move these into `LATEST_MAJORS` and drop the
 * override.
 */
const MAJOR_OVERRIDES: Record<string, Record<string, number>> = {
    "solid-v2": { "solid-js": 2, "vite-plugin-solid": 3 },
};

/**
 * The Lunora client adapter each template's UI must depend on. `standalone` has
 * no UI (server-only), and `analog` has no `@lunora/angular` adapter yet (it
 * wires the vanilla `lunorash/client` through a hand-written service) — both
 * are exempt with an explicit `null`.
 */
const REQUIRED_ADAPTER: Record<string, string | null> = {
    analog: null,
    astro: "@lunora/react",
    expo: "@lunora/react-native",
    next: "@lunora/react",
    nuxt: "@lunora/vue",
    "react-router": "@lunora/react",
    "solid-v2": "@lunora/solid",
    standalone: null,
    sveltekit: "@lunora/svelte",
    "tanstack-start-react": "@lunora/react",
    "tanstack-start-solid": "@lunora/solid",
    vinext: "@lunora/react",
    "vinext-pages": "@lunora/react",
};

/** Source files a template ships, minus generated output and installed deps. */
const SOURCE_EXTENSIONS = new Set([".astro", ".svelte", ".ts", ".tsx", ".vue"]);
const SKIPPED_DIRECTORIES = new Set(["_generated", ".next", ".nuxt", ".output", ".svelte-kit", "dist", "node_modules"]);

const listSourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(join(directory, entry.name));
        }

        return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [join(directory, entry.name)] : [];
    });

/** Drop `//` line comments so a commented-out example never reads as real code. */
const stripLineComments = (source: string): string => source.replaceAll(/^[\t ]*\/\/.*$/gm, "");

/**
 * A call site that ROUTES to a non-default shard — `{ shardKey: channelId }` —
 * as opposed to a type position (`shardKey?: string`) or a destructured
 * parameter. The negative lookahead keeps `shardKey: string` out.
 */
const SENDS_SHARD_KEY = /\bshardKey:\s*(?!(?:null|string|undefined)\b)/;

/** The worker-side gate that makes a non-default `shardKey` reachable at all. */
const DECLARES_SHARD_GATE = /\ballowUnauthenticatedShardAccess\b|\bauthorizeShard\b/;

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

        test("every Lunora dependency names a real package", () => {
            const lunoraDeps = Object.keys(deps).filter(isLunoraDep);

            // Every template wires the `lunorash` umbrella (server + values + runtime
            // + do + the CLI bin) instead of the granular base packages.
            expect(lunoraDeps).toContain("lunorash");

            for (const name of lunoraDeps) {
                expect(realLunoraPackages, `${templateName} references unknown package ${name}`).toContain(name);
            }
        });

        test("Lunora deps use the ^0.0.0 registry contract, never workspace:*", () => {
            for (const [name, range] of Object.entries(deps)) {
                if (!isLunoraDep(name)) {
                    continue;
                }

                expect(range, `${templateName} → ${name}`).toBe("^0.0.0");
            }
        });

        test("depends on the framework's Lunora client adapter", () => {
            const adapter = REQUIRED_ADAPTER[templateName];

            // A new template must be added to REQUIRED_ADAPTER (even as null) so
            // this guard is a conscious decision, not an accidental skip.
            expect(REQUIRED_ADAPTER, `add ${templateName} to REQUIRED_ADAPTER`).toHaveProperty(templateName);

            if (adapter !== null) {
                expect(Object.keys(deps)).toContain(adapter);
            }
        });

        /**
         * A template that routes a call to a non-default shard must also open or
         * gate shard access on its worker. Without `allowUnauthenticatedShardAccess`
         * or an `authorizeShard`, `createWorker` default-denies every
         * `shardKey !== "__root__"` with a 403 `FORBIDDEN_SHARD` — so the scaffold's
         * own first page load throws before a user has written a line of code.
         */
        test("a template that sends a shardKey declares a shard gate", () => {
            const sources = listSourceFiles(join(TEMPLATES_DIR, templateName)).map((file) => stripLineComments(readFileSync(file, "utf8")));

            if (!sources.some((source) => SENDS_SHARD_KEY.test(source))) {
                return;
            }

            expect(
                sources.some((source) => DECLARES_SHARD_GATE.test(source)),
                `${templateName} routes to a non-default shard but declares neither allowUnauthenticatedShardAccess nor authorizeShard`,
            ).toBe(true);
        });

        test("external framework deps are on the latest supported major", () => {
            for (const [name, range] of Object.entries(deps)) {
                if (isLunoraDep(name)) {
                    continue;
                }

                const expectedMajor = MAJOR_OVERRIDES[templateName]?.[name] ?? LATEST_MAJORS[name];

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
