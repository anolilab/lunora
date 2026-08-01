import { readFileSync } from "node:fs";
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
 * upstream's own subpath — `@lunora/flags`'s `./providers/&lt;name>` collapses
 * to `lunorash/flags/&lt;name>`, the umbrella's own naming choice. Maps
 * `&lt;upstream package name>&lt;upstream subpath>` to the umbrella suffix (the
 * part after `lunorash/&lt;prefix>`) it resolves to instead of the verbatim
 * upstream subpath.
 */
const ALIAS_SUFFIX = new Map<string, string>([
    [upstreamKey("@lunora/flags", "./providers/env"), "/env"],
    [upstreamKey("@lunora/flags", "./providers/flagship"), "/flagship"],
    [upstreamKey("@lunora/flags", "./providers/memory"), "/memory"],
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
