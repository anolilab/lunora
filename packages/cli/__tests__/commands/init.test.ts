import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTemplate, resolveTemplateFlag, resolveTemplateSource, runInitCommand } from "../../src/commands/init/handler";
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

    describe("--template resolution", () => {
        it("routes the four overlay framework names to the overlay path", () => {
            expect.assertions(4);

            // These are the values the docs table documents for `-t`; they used to
            // be dropped as "unknown template" and silently scaffold React.
            for (const framework of ["react", "solid", "svelte", "vue"]) {
                expect(resolveTemplateFlag(framework)).toStrictEqual({ vite: framework });
            }
        });

        it("errors on an unrecognised --template instead of silently scaffolding React", () => {
            expect.assertions(2);

            const resolved = resolveTemplateFlag("nextjs");

            expect(resolved).toHaveProperty("error");
            expect((resolved as { error: string }).error).toContain('unknown --template "nextjs"');
        });

        it("passes a bespoke template id straight through", () => {
            expect.assertions(2);

            expect(resolveTemplateFlag("react-router")).toStrictEqual({ templateType: "react-router" });
            expect(resolveTemplateFlag(undefined)).toStrictEqual({});
        });
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
            expect.assertions(4);

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
            expect(workspace).toContain("'esbuild': true");
            // Optional native builds a scaffold doesn't need are listed as denied
            // (so pnpm neither prompts nor requires a C/C++ toolchain).
            expect(workspace).toContain("'ssh2': false");
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

        it("prints package-manager-neutral overlay next-steps for an npm project", async () => {
            expect.assertions(3);

            // An existing react-router project that declares npm; the overlay path
            // (`--in-place`) must render its next-steps with the project's manager.
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ devDependencies: { "@react-router/dev": "^7.0.0" }, packageManager: "npm@10.9.0" }),
                "utf8",
            );
            const infos: string[] = [];
            const logger: Logger = { ...silentLogger(), info: (message) => infos.push(message) };

            const result = await runInitCommand({ cwd: workdir, inPlace: true, logger });

            const printed = infos.join("\n");

            expect(result.code).toBe(0);
            expect(printed).toContain("npm install @lunora/react");
            expect(printed).not.toContain("pnpm add");
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

        it("pins a STABLE published version exactly when the channel tag resolves to it (1.0 promotion)", async () => {
            expect.assertions(4);

            // After the 1.0 promotion the channel tag resolves to a stable
            // version; the scaffold must pin that exact version — never the
            // `^0.0.0` placeholder and never a floating `alpha` tag.
            stubRegistry("1.0.0");

            await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "stable-stamped",
                templateType: "tanstack-start-react",
            });

            const pkg = JSON.parse(readFileSync(join(workdir, "stable-stamped", "package.json"), "utf8")) as {
                dependencies: Record<string, string>;
                devDependencies: Record<string, string>;
            };

            expect(pkg.dependencies.lunorash).toBe("1.0.0");
            expect(pkg.dependencies["@lunora/react"]).toBe("1.0.0");
            expect(pkg.devDependencies["@lunora/vite"]).toBe("1.0.0");

            const raw = readFileSync(join(workdir, "stable-stamped", "package.json"), "utf8");

            expect(raw).not.toContain("^0.0.0");
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

        it("solid-v2 template scaffolds a Solid 2 SPA on the 2.x toolchain", async () => {
            expect.assertions(11);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "starter",
                templateType: "solid-v2",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "starter");

            expect(existsSync(join(target, "index.html"))).toBe(true);
            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
            expect(existsSync(join(target, "src", "index.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "App.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "server.ts"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);

            const pkg = readFileSync(join(target, "package.json"), "utf8");

            // The 2.x toolchain, not the 1.x one: Solid 2 ships its renderer as a
            // separate package and needs the matching (3.x) Vite plugin.
            expect(pkg).toContain('"solid-js": "^2.');
            expect(pkg).toContain("@solidjs/web");
            expect(pkg).toContain('"vite-plugin-solid": "^3.');
            expect(pkg).toContain('"name": "starter"');
        });

        it("next template scaffolds app router + two-worker entries", async () => {
            expect.assertions(13);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "next-app",
                templateType: "next",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "next-app");

            expect(existsSync(join(target, "next.config.ts"))).toBe(true);
            expect(existsSync(join(target, "open-next.config.ts"))).toBe(true);
            expect(existsSync(join(target, "app", "layout.tsx"))).toBe(true);
            expect(existsSync(join(target, "app", "page.tsx"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            // Two-worker split. The ROOT `wrangler.jsonc` is the LUNORA worker — that is
            // where `lunora verify|deploy|dev` look, and they require the SHARD binding —
            // and the Next SSR worker config sits beside it, passed to every OpenNext
            // command with `--config`.
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            expect(existsSync(join(target, "wrangler.opennext.jsonc"))).toBe(true);
            expect(readFileSync(join(target, "wrangler.jsonc"), "utf8")).toContain('"class_name": "ShardDO"');
            expect(existsSync(join(target, "lunora", "server.ts"))).toBe(true);

            const pkg = readFileSync(join(target, "package.json"), "utf8");

            expect(pkg).toContain('"next"');
            expect(pkg).toContain("@lunora/react");
            expect(pkg).toContain('"name": "next-app"');
        });

        it("vinext (App Router) template scaffolds the class-A composed worker", async () => {
            expect.assertions(4);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "vinext-app",
                templateType: "vinext",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "vinext-app");

            // App-Router scaffold: app/ directory + the composed `virtual:lunora/worker` entry.
            expect(existsSync(join(target, "app", "page.tsx"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(readFileSync(join(target, "wrangler.jsonc"), "utf8")).toContain("virtual:lunora/worker");
        });

        it("vinext-pages (Pages Router) template scaffolds the class-A composed worker", async () => {
            expect.assertions(4);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "vinext-pages-app",
                templateType: "vinext-pages",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "vinext-pages-app");

            // Pages-Router scaffold: pages/ + the composed `virtual:lunora/worker` entry.
            expect(existsSync(join(target, "pages", "index.tsx"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(readFileSync(join(target, "wrangler.jsonc"), "utf8")).toContain("virtual:lunora/worker");
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

        it("refuses an empty project name", async () => {
            expect.assertions(3);

            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("refusing an empty project name");
            // cwd itself must not have been scaffolded into (e.g. no package.json dropped in workdir)
            expect(existsSync(join(workdir, "package.json"))).toBe(false);
        });

        it("refuses a whitespace-only project name", async () => {
            expect.assertions(3);

            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "   ",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("refusing an empty project name");
            expect(existsSync(join(workdir, "   "))).toBe(false);
        });

        it("trims a whitespace-padded name so the target dir is not whitespace-padded", async () => {
            expect.assertions(3);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "  padded-app  ",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);
            // The trimmed name is used for the target dir — no whitespace-padded folder.
            expect(existsSync(join(workdir, "padded-app", "package.json"))).toBe(true);
            expect(existsSync(join(workdir, "  padded-app  "))).toBe(false);
        });

        it("fails instead of reporting success when the template directory holds no files", async () => {
            expect.assertions(3);

            // A template subdirectory that exists but is empty — what a bad
            // `--ref` / `--source` / template-name typo produces remotely, since
            // giget drops every entry outside the requested subdir without
            // throwing. This used to copy 0 files and exit 0 with
            // "Project initialized!" over an empty project directory.
            const emptySource = join(workdir, "empty-templates");

            mkdirSync(join(emptySource, "tanstack-start-react"), { recursive: true });

            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: emptySource,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "hollow",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("no files");
            expect(existsSync(join(workdir, "hollow"))).toBe(false);
        });

        it("refuses a project name wrangler will reject as a worker name", async () => {
            expect.assertions(3);

            // wrangler's own `isValidName` is /^$|^[a-z0-9_][a-z0-9-_]*$/ and a
            // hard error, so `MyApp` scaffolds fine and then fails every
            // `wrangler dev` / `deploy` on the substituted `name` field.
            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "MyApp",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("my-app");
            expect(existsSync(join(workdir, "MyApp"))).toBe(false);
        });

        it("does not let a $-pattern in the name corrupt {{name}} substitution", async () => {
            expect.assertions(2);

            // `String.replaceAll` interprets `$&` / `$'` in a STRING replacement,
            // so a name carrying one used to splice the matched text back in.
            const errors: string[] = [];

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: { ...silentLogger(), error: (message) => errors.push(message) },
                name: "app-$&-x",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("lowercase");
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

        it("isTemplate accepts the real template dir names incl. next and vinext (not the removed vite-react)", () => {
            expect.assertions(13);

            expect(isTemplate("astro")).toBe(true);
            expect(isTemplate("expo")).toBe(true);
            expect(isTemplate("next")).toBe(true);
            expect(isTemplate("nuxt")).toBe(true);
            expect(isTemplate("solid-v2")).toBe(true);
            expect(isTemplate("standalone")).toBe(true);
            expect(isTemplate("sveltekit")).toBe(true);
            expect(isTemplate("tanstack-start-react")).toBe(true);
            expect(isTemplate("tanstack-start-solid")).toBe(true);
            expect(isTemplate("vinext")).toBe(true);
            expect(isTemplate("vinext-pages")).toBe(true);
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

        it("expo template scaffolds the RN client, worker backend, and app config", async () => {
            expect.assertions(8);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "expo-app",
                templateType: "expo",
            });

            expect(result.code).toBe(0);

            const target = join(workdir, "expo-app");
            const appJson = readFileSync(join(target, "app.json"), "utf8");

            // Expo-specific entry + config — proves we did NOT fall back to vite.
            expect(existsSync(join(target, "app.json"))).toBe(true);
            expect(existsSync(join(target, "App.tsx"))).toBe(true);
            expect(existsSync(join(target, "src", "Chat.tsx"))).toBe(true);
            // The worker backend + Lunora schema.
            expect(existsSync(join(target, "src", "server", "index.ts"))).toBe(true);
            expect(existsSync(join(target, "lunora", "schema.ts"))).toBe(true);
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            // {{name}} is substituted into the app manifest.
            expect(appJson).toContain('"slug": "expo-app"');
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
