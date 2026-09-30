import { describe, expect, it } from "vitest";

import { decideBuild, effectiveWatchPaths, normalizeRootDirectory, normalizeWatchPaths } from "../src/builds/paths";

/**
 * Monorepo build settings. The root directory ends up as a path the build box
 * resolves inside a tenant's extracted repo, so traversal has to be refused
 * here AND there; the path filter decides whether a push deploys at all, so
 * every case where it cannot tell must build.
 */

describe(normalizeRootDirectory, () => {
    it.each(["", ".", "./", "  "])("treats %j as the repository root", (input) => {
        expect(normalizeRootDirectory(input)).toBe("");
    });

    it("accepts a normalized relative path and forgives one trailing slash", () => {
        expect(normalizeRootDirectory("apps/web")).toBe("apps/web");
        expect(normalizeRootDirectory("apps/web/")).toBe("apps/web");
    });

    it.each([
        ["..", /normalized/u],
        ["../secrets", /normalized/u],
        ["apps/../../etc", /normalized/u],
        ["apps/./web", /normalized/u],
        ["apps//web", /normalized/u],
        ["/etc", /leading "\/"/u],
        [String.raw`apps\web`, /backslash/u],
        ["apps/web\u0000", /control/u],
        ["a".repeat(257), /at most 256/u],
    ])("refuses %j", (input, message) => {
        expect(() => normalizeRootDirectory(input)).toThrow(message);
    });
});

describe(normalizeWatchPaths, () => {
    it("trims and drops blank lines", () => {
        expect(normalizeWatchPaths([" apps/web/** ", "", "packages/ui/**"])).toStrictEqual(["apps/web/**", "packages/ui/**"]);
    });

    it.each([
        [["!apps/web/**"], /negated/u],
        [["../other/**"], /normalized/u],
        [["/abs/**"], /leading/u],
        [Array.from({ length: 21 }, (_, index) => `p${String(index)}/**`), /at most 20/u],
    ])("refuses %j", (input, message) => {
        expect(() => normalizeWatchPaths(input)).toThrow(message);
    });
});

describe(effectiveWatchPaths, () => {
    it("defaults to the root directory plus every lockfile on the way down to it", () => {
        expect(effectiveWatchPaths("apps/web", undefined)).toStrictEqual([
            "apps/web/**",
            "pnpm-lock.yaml",
            "package-lock.json",
            "yarn.lock",
            "apps/pnpm-lock.yaml",
            "apps/package-lock.json",
            "apps/yarn.lock",
            "apps/web/pnpm-lock.yaml",
            "apps/web/package-lock.json",
            "apps/web/yarn.lock",
        ]);
    });

    it("keeps the root lockfiles when explicit watch paths replace the default", () => {
        expect(effectiveWatchPaths(undefined, ["packages/**"])).toStrictEqual(["packages/**", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
    });
});

describe(decideBuild, () => {
    it("builds when a changed file is under the root directory", () => {
        expect(decideBuild({ files: ["README.md", "apps/web/src/index.ts"] }, "apps/web", undefined)).toStrictEqual({
            build: true,
            reason: "apps/web/src/index.ts changed",
        });
    });

    it("counts dotfiles", () => {
        expect(decideBuild({ files: ["apps/web/.env.example"] }, "apps/web", undefined).build).toBe(true);
    });

    it("skips, with a reason naming the watched paths, when nothing matches", () => {
        expect(decideBuild({ files: ["apps/docs/index.md", "apps/web-admin/x.ts"] }, "apps/web", undefined)).toStrictEqual({
            build: false,
            reason: "no changes under apps/web/ or the lockfile (2 files changed)",
        });
    });

    it("builds on a root lockfile change even when no app file changed", () => {
        expect(decideBuild({ files: ["pnpm-lock.yaml"] }, "apps/web", undefined).build).toBe(true);
    });

    it("matches explicit watch paths instead of the root directory", () => {
        expect(decideBuild({ files: ["packages/ui/button.tsx"] }, "apps/web", ["packages/ui/**"]).build).toBe(true);
        expect(decideBuild({ files: ["apps/web/index.ts"] }, "apps/web", ["packages/ui/**"])).toMatchObject({
            build: false,
            reason: expect.stringContaining("packages/ui/**"),
        });
    });

    it("always builds a project rooted at the repository root", () => {
        expect(decideBuild({ files: ["anything.txt"] }, undefined, undefined).build).toBe(true);
    });

    it("fails open when the push cannot prove its changes", () => {
        expect(decideBuild({ unknown: "forced push" }, "apps/web", undefined)).toStrictEqual({
            build: true,
            reason: "building without a path check: forced push",
        });
    });
});
