import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoPackagesRoot = join(packageRoot, "..");

const sorted = (keys: ReadonlyArray<string>): ReadonlyArray<string> => [...keys].toSorted((a, b) => a.localeCompare(b));

interface UpstreamManifest {
    exports?: Record<string, unknown>;
    name: string;
}

const readManifest = (packageDirName: string): UpstreamManifest =>
    JSON.parse(readFileSync(join(monorepoPackagesRoot, packageDirName, "package.json"), "utf8")) as UpstreamManifest;

const umbrellaManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as UpstreamManifest;
const umbrellaSubpaths = new Set(Object.keys(umbrellaManifest.exports ?? {}));

// Every upstream package the umbrella re-exports from, and the `packages/<dir>`
// its manifest lives in. `@lunora/server`'s "." also aliases to the bare
// `lunorash` default export (see `packages/lunora/src/index.ts`) — everything
// else maps 1:1 onto `lunorash/<the upstream package's own unscoped name>`.
const UPSTREAM_PACKAGE_DIRS: ReadonlyArray<string> = [
    "server",
    "values",
    "errors",
    "runtime",
    "do",
    "platform",
    "observability",
    "client",
    "flags",
    "ratelimit",
];

// Key shared by OPT_OUT/ALIAS_SUFFIX below and the lookup in buildReExportCases:
// the upstream package name with its subpath appended verbatim (subpath's
// leading "." dropped, so "." itself contributes nothing) — e.g. "@lunora/flags/providers/env".
const upstreamKey = (packageName: string, upstreamSubpath: string): string => `${packageName}${upstreamSubpath.slice(1)}`;

/**
 * Upstream subpaths deliberately NOT re-exported by the umbrella, with the
 * reason each is excluded. Anything upstream not covered by this list or by
 * {@link ALIAS_SUFFIX} must resolve to a real `lunorash/*` subpath — that's
 * the parity check below. Add a new opt-out here (with a reason) rather than
 * letting a future upstream subpath silently fall through the umbrella.
 */
const OPT_OUT = new Map<string, string>([
    [
        upstreamKey("@lunora/platform", "./conformance"),
        "the behavioural TCK versions in lockstep with the @lunora/platform contracts it asserts, not the umbrella's opinionated re-export surface — a host author consumes @lunora/platform/conformance directly",
    ],
    [upstreamKey("@lunora/platform", "./conformance/suite"), "same as ./conformance above — the workerd-safe pure suite is part of the same TCK"],
]);

/**
 * Upstream subpaths the umbrella re-exports under a DIFFERENT suffix than the
 * upstream's own subpath — `@lunora/flags`'s `./providers/<name>` collapses
 * to `lunorash/flags/<name>`, the umbrella's own naming choice. Maps
 * `<upstream package name><upstream subpath>` to the umbrella suffix (the
 * part after `lunorash/<prefix>`) it resolves to instead of the verbatim
 * upstream subpath.
 */
const ALIAS_SUFFIX = new Map<string, string>([
    [upstreamKey("@lunora/flags", "./providers/env"), "/env"],
    [upstreamKey("@lunora/flags", "./providers/flagship"), "/flagship"],
    [upstreamKey("@lunora/flags", "./providers/memory"), "/memory"],
]);

/**
 * Packages deliberately NOT re-exported by the umbrella, with the reason. Every
 * `packages/*` directory must appear either in UPSTREAM_PACKAGE_DIRS or here —
 * the completeness test below enforces it, so a new package cannot be silently
 * absent from the umbrella without a recorded decision.
 */
const PACKAGE_OPT_OUT = new Map<string, string>([
    ["advisor", "tooling — dev-time lints feeding the Studio, not a runtime re-export"],
    ["agent", "add-on — installed directly when used"],
    ["ai", "add-on — installed directly when used"],
    ["angular", "framework adapter — installed per framework, not part of the base surface"],
    ["astro", "framework adapter — installed per framework, not part of the base surface"],
    ["auth", "add-on — installed directly when used"],
    ["auth-ui", "internal, not published"],
    ["bindings", "add-on — installed directly when used"],
    ["browser", "add-on — installed directly when used"],
    ["cli", "tooling — its runCli already ships through the umbrella's `lunora` bin (src/bin.ts), not as a module re-export"],
    ["cloudflare-access", "add-on — installed directly when used"],
    ["codegen", "tooling — dev-time, not a runtime re-export"],
    ["config", "tooling — internal CLI+Vite config/scaffolding, not a runtime re-export"],
    ["container", "add-on — installed directly when used"],
    ["d1", "host/engine layer — .global() backend consumed by the runtime, never app code"],
    ["db", "TanStack DB binding — installed alongside the framework adapter that uses it, not part of the base surface"],
    ["dispatch", "internal, not published"],
    ["fingerprint", "add-on — zero-dep error grouping, installed directly when used"],
    ["hyperdrive", "add-on — installed directly when used"],
    ["lunora", "the umbrella itself"],
    ["mail", "add-on — installed directly when used"],
    ["mcp", "add-on — installed directly when used"],
    ["notify", "add-on — installed directly when used"],
    ["nuxt", "framework adapter — installed per framework, not part of the base surface"],
    ["payment", "optional add-on with heavy provider deps — installed directly"],
    ["platform-celld", "host/engine layer — experimental celld host, never app code"],
    ["platform-cloudflare", "host/engine layer — consumed by @lunora/do, never app code"],
    ["platform-node", "host/engine layer — experimental Node host, never app code"],
    ["queue", "add-on — installed directly when used"],
    ["react", "framework adapter — installed per framework, not part of the base surface"],
    ["react-native", "framework adapter — installed per framework, not part of the base surface"],
    ["replica", "local-first replica runtime — installed directly by apps that opt into local mirrors"],
    ["scheduler", "add-on — installed directly when used"],
    ["search-core", "internal, not published"],
    ["seed", "tooling — dev-time seeding, installed directly where used"],
    ["shard-engine", "host/engine layer — consumed by platform hosts, never app code"],
    ["solid", "framework adapter — installed per framework, not part of the base surface"],
    ["sql-store", "internal dialect-parameterized SQL store core — consumed by .global() backends, never app code"],
    ["storage", "add-on — installed directly when used"],
    ["studio", "tooling — the local admin UI, embedded by the CLI/Vite, not a runtime re-export"],
    ["svelte", "framework adapter — installed per framework, not part of the base surface"],
    ["testing", "tooling — test harness, installed directly by test suites"],
    ["vite", "tooling — the Vite plugin is its own install, not a runtime re-export"],
    ["vue", "framework adapter — installed per framework, not part of the base surface"],
    ["workflow", "add-on — installed directly when used"],
    ["x402", "optional add-on with heavy provider/chain deps — installed directly"],
]);

interface ReExportCase {
    umbrellaSpecifier: string;
    umbrellaSubpath: string;
    upstreamSpecifier: string;
}

const buildReExportCases = (): ReExportCase[] => {
    const cases: ReExportCase[] = [];

    for (const dir of UPSTREAM_PACKAGE_DIRS) {
        const manifest = readManifest(dir);
        const prefix = manifest.name.replace(/^@lunora\//, "");

        for (const upstreamSubpath of Object.keys(manifest.exports ?? {})) {
            if (upstreamSubpath === "./package.json") {
                continue;
            }

            const key = upstreamKey(manifest.name, upstreamSubpath);

            if (OPT_OUT.has(key)) {
                continue;
            }

            // `.` (upstream root) maps to `lunorash/<prefix>` with no suffix;
            // every other upstream subpath appends its own segment (aliased or not).
            const suffix = ALIAS_SUFFIX.get(key) ?? (upstreamSubpath === "." ? "" : upstreamSubpath.slice(1));
            const umbrellaSubpath = `./${prefix}${suffix}`;

            cases.push({
                umbrellaSpecifier: `lunorash${umbrellaSubpath.slice(1)}`,
                umbrellaSubpath,
                upstreamSpecifier: upstreamSubpath === "." ? manifest.name : `${manifest.name}${upstreamSubpath.slice(1)}`,
            });
        }
    }

    // `@lunora/server`'s root additionally aliases to the bare umbrella default
    // export (`import { query } from "lunorash"`), not just `lunorash/server`.
    cases.push({ umbrellaSpecifier: "lunorash", umbrellaSubpath: ".", upstreamSpecifier: "@lunora/server" });

    return cases;
};

const reExportCases = buildReExportCases();

describe("lunora umbrella re-exports", () => {
    // `it.each([])` registers ZERO tests and reports green, and `expect.hasAssertions()` in the test
    // below is satisfied by the one unconditionally-pushed `@lunora/server` case — so a scan that
    // yields nothing (a renamed packages/<dir>, an `exports` key that moved) would delete the
    // forwarding gate silently. Pin the floor to the derivation's own inputs.
    it("derives at least one case per upstream package, so the gates below cannot collapse", () => {
        expect.assertions(2);

        const covered = new Set(reExportCases.map(({ umbrellaSubpath }) => umbrellaSubpath.slice(2).split("/")[0]));
        const missing = UPSTREAM_PACKAGE_DIRS.filter((dir) => !covered.has(dir));

        expect(missing).toStrictEqual([]);
        expect(reExportCases.length).toBeGreaterThan(UPSTREAM_PACKAGE_DIRS.length);
    });

    it("has a mapping for every upstream subpath (deliberate opt-outs excepted)", () => {
        expect.hasAssertions();

        for (const { umbrellaSubpath, upstreamSpecifier } of reExportCases) {
            expect(umbrellaSubpaths.has(umbrellaSubpath), `${upstreamSpecifier} has no matching ${umbrellaSubpath} entry in packages/lunora/package.json`).toBe(
                true,
            );
        }
    });

    it.each(reExportCases.map(({ umbrellaSpecifier, upstreamSpecifier }): [string, string] => [umbrellaSpecifier, upstreamSpecifier]))(
        "forwards %s from %s",
        async (umbrella, upstream) => {
            expect.assertions(1);

            const viaUmbrella = await import(umbrella);
            const direct = await import(upstream);

            expect(sorted(Object.keys(viaUmbrella))).toStrictEqual(sorted(Object.keys(direct)));
        },
    );
});

describe("lunora umbrella package coverage", () => {
    it("every packages/* directory is either re-exported or opted out with a reason", () => {
        expect.assertions(3);

        // Only directories holding a manifest are packages. A renamed or deleted
        // package leaves its `packages/<dir>/node_modules` behind — untracked, so
        // invisible to `git status` — and counting that as an unaccounted package
        // would fail this test on one working copy while CI stays green.
        const dirs = readdirSync(monorepoPackagesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(join(monorepoPackagesRoot, entry.name, "package.json")))
            .map((entry) => entry.name);

        const unaccounted = dirs.filter((dir) => !UPSTREAM_PACKAGE_DIRS.includes(dir) && !PACKAGE_OPT_OUT.has(dir));
        const stale = [...PACKAGE_OPT_OUT.keys()].filter((dir) => !dirs.includes(dir));
        const doubled = UPSTREAM_PACKAGE_DIRS.filter((dir) => PACKAGE_OPT_OUT.has(dir));

        expect(unaccounted, "add each to UPSTREAM_PACKAGE_DIRS or PACKAGE_OPT_OUT (with a reason)").toEqual([]);
        expect(stale, "PACKAGE_OPT_OUT names dirs that no longer exist").toEqual([]);
        expect(doubled, "a dir cannot be both re-exported and opted out").toEqual([]);
    });
});
