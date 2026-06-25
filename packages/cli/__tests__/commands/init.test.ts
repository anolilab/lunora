import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTemplate, resolveTemplateSource, runInitCommand } from "../../src/commands/init/handler";
import type { Logger } from "../../src/util/logger";
import { resolveDistTag } from "../../src/util/source-ref";
import { createRecordingSpawner } from "../../src/util/spawn";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

// __tests__/commands/ -> package root -> monorepo root -> templates/
const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "..", "templates");

let workdir: string;

describe("lunora init", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-init-"));
        // Default: no network. Scaffolding resolves `@lunora/*` dep versions from the
        // registry; stub it offline so the suite is hermetic (deps fall back to the
        // dist-tag). Tests that assert concrete pinning override via `stubRegistry`.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("no network in tests");
            }),
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.unstubAllGlobals();
    });

    /** Stub the registry so `resolveTagVersion` resolves every dist-tag to `version` (deterministic, offline). */
    const stubRegistry = (version: string): void => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                return {
                    json: async () => {
                        return { "dist-tags": { alpha: version, beta: version, latest: version, next: version } };
                    },
                    ok: true,
                };
            }),
        );
    };

    describe("lunora init", () => {
        it("a bespoke template scaffolds its expected files", async () => {
            expect.assertions(11);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "my-app",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "my-app");

            expect(existsSync(join(target, "package.json"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(existsSync(join(target, "lunora", "messages.ts"))).toBe(true);
            expect(existsSync(join(target, "src", "router.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "routes", "__root.tsx"))).toBe(true);
            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            expect(existsSync(join(target, "tsconfig.json"))).toBe(true);
            expect(existsSync(join(target, ".gitignore"))).toBe(true);
            expect(existsSync(join(target, "README.md"))).toBe(true);
        });

        it("offers to install dependencies and runs the preferred package manager", async () => {
            expect.assertions(3);

            const { calls, spawner } = createRecordingSpawner();

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                installPrompt: { confirmInstall: () => Promise.resolve(true), selectManager: (managers) => Promise.resolve(managers[0]!) },
                logger: silentLogger(),
                name: "installed-app",
                // Both pnpm + npm "installed" → pnpm is preferred (the default).
                packageManagerProbe: (manager) => manager === "pnpm" || manager === "npm",
                spawner,
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor).toMatchObject({ args: ["install"], command: "pnpm", cwd: join(workdir, "installed-app") });
        });

        it("writes pnpm-workspace.yaml with the allowBuilds allowlist before a pnpm install", async () => {
            expect.assertions(3);

            const { spawner } = createRecordingSpawner();

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                installPrompt: { confirmInstall: () => Promise.resolve(true), selectManager: (managers) => Promise.resolve(managers[0]!) },
                logger: silentLogger(),
                name: "installed-app",
                packageManagerProbe: (manager) => manager === "pnpm",
                spawner,
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);

            const workspace = readFileSync(join(workdir, "installed-app", "pnpm-workspace.yaml"), "utf8");

            // pnpm 11 honours `allowBuilds:` (a name→true map), NOT the legacy
            // `onlyBuiltDependencies:` array — so `pnpm install` runs the native
            // build scripts without the interactive `pnpm approve-builds` step.
            expect(workspace).toContain("allowBuilds:");
            expect(workspace).toContain("esbuild: true");
        });

        it("does not install when the user declines the offer", async () => {
            expect.assertions(2);

            const { calls, spawner } = createRecordingSpawner();

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                installPrompt: { confirmInstall: () => Promise.resolve(false), selectManager: (managers) => Promise.resolve(managers[0]!) },
                logger: silentLogger(),
                name: "declined-app",
                packageManagerProbe: () => true,
                spawner,
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(0);
        });

        it("does not offer to install in a non-interactive run (no prompts injected)", async () => {
            expect.assertions(2);

            const { calls, spawner } = createRecordingSpawner();

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "ci-app",
                packageManagerProbe: () => true,
                spawner,
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(0);
        });

        it("substitutes {{name}} placeholders", async () => {
            expect.assertions(3);

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "rainbow",
                templateType: "tanstack-start-react",
            });

            const pkg = readFileSync(join(workdir, "rainbow", "package.json"), "utf8");
            const wrangler = readFileSync(join(workdir, "rainbow", "wrangler.jsonc"), "utf8");
            const root = readFileSync(join(workdir, "rainbow", "src", "routes", "__root.tsx"), "utf8");

            expect(pkg).toContain('"name": "rainbow"');
            expect(wrangler).toContain('"name": "rainbow"');
            expect(root).toContain('title: "rainbow"');
        });

        it("a template's package.json references the lunora packages (umbrella base)", async () => {
            expect.assertions(7);

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "demo",
                templateType: "tanstack-start-react",
            });

            const pkg = readFileSync(join(workdir, "demo", "package.json"), "utf8");

            // The base packages (server/values/runtime/do/client) ship via the single
            // `lunorash` umbrella; only the framework adapter and Vite plugin are granular.
            expect(pkg).toContain("lunorash");
            expect(pkg).toContain("@lunora/react");
            expect(pkg).toContain("@lunora/vite");
            expect(pkg).toContain("react-dom");
            expect(pkg).toContain("vite");
            expect(pkg).toContain("wrangler");
            expect(pkg).not.toContain("@lunora/server");
        });

        it("pins the template's lunora deps to the concrete published version, leaving others untouched", async () => {
            expect.assertions(5);

            // Registry resolves the channel tag to this exact version; the scaffold
            // must pin it (not the floating tag) so a stale lockfile can't downgrade.
            stubRegistry("1.0.0-alpha.99");

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "stamped",
                templateType: "tanstack-start-react",
            });

            const pkg = JSON.parse(readFileSync(join(workdir, "stamped", "package.json"), "utf8")) as {
                dependencies: Record<string, string>;
                devDependencies: Record<string, string>;
            };

            // Lunora-scoped ranges are pinned to the concrete version; the `^0.0.0` stub is gone.
            expect(pkg.dependencies.lunorash).toBe("1.0.0-alpha.99");
            expect(pkg.dependencies["@lunora/react"]).toBe("1.0.0-alpha.99");
            expect(pkg.devDependencies["@lunora/vite"]).toBe("1.0.0-alpha.99");
            // Third-party deps keep their template ranges verbatim.
            expect(pkg.dependencies["react-dom"]).toBe("^19.0.0");
            expect(pkg.devDependencies.wrangler).toBe("^4.74.0");
        });

        it("falls back to the channel dist-tag when the registry lookup fails (offline)", async () => {
            expect.assertions(2);

            // Registry unreachable → resolveTagVersion returns undefined → keep the tag.
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => {
                    throw new Error("offline");
                }),
            );

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "offline",
                templateType: "tanstack-start-react",
            });

            const pkg = JSON.parse(readFileSync(join(workdir, "offline", "package.json"), "utf8")) as { dependencies: Record<string, string> };
            const tag = resolveDistTag();

            expect(pkg.dependencies.lunorash).toBe(tag);
            expect(tag.length).toBeGreaterThan(0);
        });

        it("standalone template scaffolds a worker entry but no frontend files", async () => {
            expect.assertions(6);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "worker-only",
                templateType: "standalone",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "worker-only");

            // The Worker entry (`wrangler.jsonc` `main`) lives in `src/server.ts`.
            expect(existsSync(join(target, "src", "server.ts"))).toBe(true);
            // …but nothing frontend: no Vite config, no HTML entry.
            expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
            expect(existsSync(join(target, "index.html"))).toBe(false);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
        });

        it("tanstack-start-react template scaffolds router + route entries", async () => {
            expect.assertions(10);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "starter",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "starter");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
            expect(existsSync(join(target, "src", "router.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "routes", "__root.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "routes", "index.tsx"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);

            const pkg = readFileSync(join(target, "package.json"), "utf8");

            expect(pkg).toContain("@tanstack/react-start");
            expect(pkg).toContain("@lunora/react");
            expect(pkg).toContain('"name": "starter"');
        });

        it("tanstack-start-solid template scaffolds router + route entries", async () => {
            expect.assertions(10);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "starter",
                templateType: "tanstack-start-solid",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "starter");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
            expect(existsSync(join(target, "src", "router.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "routes", "__root.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "routes", "index.tsx"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);

            const pkg = readFileSync(join(target, "package.json"), "utf8");

            expect(pkg).toContain("@tanstack/solid-start");
            expect(pkg).toContain("@lunora/solid");
            expect(pkg).toContain('"name": "starter"');
        });

        it("next template is not yet available", async () => {
            expect.assertions(2);

            const warnings: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), warn: (message) => warnings.push(message) },
                name: "soon",
                templateType: "next",
            });

            expect(result.code).toBe(1);
            expect(warnings.join("\n")).toContain("not yet available");
        });

        it("refuses to scaffold into a non-empty target", async () => {
            expect.assertions(2);

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "dup",
                templateType: "tanstack-start-react",
            });

            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "dup",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("not empty");
        });

        it("--from with missing template reports a helpful error", async () => {
            expect.assertions(2);

            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: join(workdir, "does-not-exist"),
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "broken",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("template not found in local source");
        });

        it("isTemplate accepts the 6 real template dir names and next (not the removed vite-react)", () => {
            expect.assertions(9);

            expect(isTemplate("astro")).toBe(true);
            expect(isTemplate("nuxt")).toBe(true);
            expect(isTemplate("standalone")).toBe(true);
            expect(isTemplate("sveltekit")).toBe(true);
            expect(isTemplate("tanstack-start-react")).toBe(true);
            expect(isTemplate("tanstack-start-solid")).toBe(true);
            expect(isTemplate("next")).toBe(true);
            expect(isTemplate("vite-react")).toBe(false);
            expect(isTemplate("unknown-framework")).toBe(false);
        });

        it("astro template scaffolds expected files (not vite fallback)", async () => {
            expect.assertions(5);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "astro-app",
                templateType: "astro",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "astro-app");

            // astro.config.mjs is astro-specific — proves we did NOT fall back to vite
            expect(existsSync(join(target, "astro.config.mjs"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            // vite.config.ts does NOT exist in the astro template (class-B framework)
            expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
        });
    });

    describe("template source resolution", () => {
        it("an explicit --ref overrides the version-derived default", () => {
            expect.assertions(1);

            expect(resolveTemplateSource("tanstack-start-react", undefined, "alpha")).toBe("gh:anolilab/lunora/templates/tanstack-start-react#alpha");
        });

        it("a full --source wins over both --ref and the default", () => {
            expect.assertions(1);

            expect(resolveTemplateSource("tanstack-start-react", "gh:me/fork/templates/tanstack-start-react#main", "alpha")).toBe(
                "gh:me/fork/templates/tanstack-start-react#main",
            );
        });
    });
});
