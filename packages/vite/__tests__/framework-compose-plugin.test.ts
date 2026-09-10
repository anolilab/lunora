/**
 * Detection-driven class-A worker composition (PLAN4 M2).
 *
 * The plugin reads the detected framework off the shared `LunoraPluginContext`
 * and, for a class-A framework, resolves `virtual:lunora/worker` to a generated
 * worker entry that composes the framework SSR handler under `composeWorker`'s
 * `httpRouter` seam. These tests drive the plugin's `resolveId`/`load` hooks
 * directly (no real framework packages, matching the existing fakes pattern)
 * plus assert the emitted source routes `/_lunora/*` to Lunora and falls
 * through to the framework handler.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENERATED_CLASS_MODULES } from "@lunora/config";
import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DetectedFramework, FrameworkClass } from "../src/detect-framework";
import {
    buildWorkerEntrySource,
    frameworkComposePlugin,
    isAutoComposable,
    LUNORA_WORKER_VIRTUAL_ID,
    RESOLVED_LUNORA_WORKER_ID,
} from "../src/framework-compose-plugin";
import type { LunoraPluginContext } from "../src/framework-detect-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

const baseOptions = (overrides: Partial<ResolvedLunoraPluginOptions> = {}): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: {},
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot: "/workspace/app",
        schemaDir: "lunora",
        shard: {},
        target: "cloudflare",
        studio: true,
        validateWrangler: true,
        ...overrides,
    };
};

const context = (framework: DetectedFramework, klass: FrameworkClass): LunoraPluginContext => {
    return { framework: { class: klass, framework } };
};

/** Call a plugin's `resolveId` hook regardless of whether it is a fn or `{ handler }`. */
const callResolveId = (plugin: Plugin, id: string): unknown => {
    const hook = plugin.resolveId;
    const run = typeof hook === "function" ? hook : hook?.handler;

    return run?.call({} as never, id, undefined, {} as never);
};

/**
 * Call a plugin's `load` hook regardless of whether it is a fn or `{ handler }`.
 * Vite 8 always runs hooks within an environment context; the worker virtual is
 * emitted in every non-"client" environment, so the harness defaults to `"ssr"`
 * (the real-entry path) and callers pass an explicit name when they care.
 */
const callLoad = async (plugin: Plugin, id: string, environment = "ssr"): Promise<unknown> => {
    const hook = plugin.load;
    const run = typeof hook === "function" ? hook : hook?.handler;

    return await run?.call({ environment: { name: environment } } as never, id, undefined as never);
};

describe("framework-compose-plugin", () => {
    describe("isAutoComposable", () => {
        it("is true for each known class-A framework", async () => {
            expect.hasAssertions();

            expect(isAutoComposable(context("tanstack-start", "A"))).toBe(true);
            expect(isAutoComposable(context("react-router", "A"))).toBe(true);
            expect(isAutoComposable(context("solid-start", "A"))).toBe(true);
        });

        it("is false for class-B, class-C, and undetected projects", async () => {
            expect.hasAssertions();

            expect(isAutoComposable(context("sveltekit", "B"))).toBe(false);
            expect(isAutoComposable(context("none", "C"))).toBe(false);
            expect(isAutoComposable({})).toBe(false);
        });
    });

    describe("resolveId / load (class A → composition)", () => {
        it("resolves the virtual worker id for a class-A project", async () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("tanstack-start", "A"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBe(RESOLVED_LUNORA_WORKER_ID);
            // Unrelated ids are never claimed.
            expect(callResolveId(plugin, "some-other-module")).toBeUndefined();
        });

        it("loads a defineApp entry that routes _lunora to Lunora and falls through to the framework SSR handler", async () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("react-router", "A"));
            const source = await callLoad(plugin, RESOLVED_LUNORA_WORKER_ID);

            expect(typeof source).toBe("string");

            const code = source as string;

            // Composition is via the generated `defineApp()` builder with the
            // framework handler on its httpRouter seam — the worker that routes
            // /_lunora/* to Lunora and everything else to the framework handler
            // (precedence enforced inside @lunora/runtime).
            expect(code).toContain("defineApp()");
            expect(code).toContain(".httpRouter(");
            expect(code).toContain(".shard((env) => env.SHARD)");
            // React Router wiring: createRequestHandler over its virtual build.
            expect(code).toContain('from "react-router"');
            expect(code).toContain("virtual:react-router/server-build");
            // The generated builder is wired in via an ABSOLUTE path (projectRoot +
            // generatedDir). Virtual modules have no real filesystem path so
            // relative specifiers like "./lunora/_generated/..." can't be resolved
            // by Vite/rolldown — absolute paths work in all bundler environments.
            // baseOptions() uses projectRoot="/workspace/app", generatedDir="lunora/_generated".
            expect(code).toContain('import { defineApp } from "/workspace/app/lunora/_generated/app"');
            expect(code).toContain("export default app;");
        });

        it("emits a worker-free stub in the client environment but the real entry in the worker environment", async () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("react-router", "A"));

            // Browser environment: a stub with none of the worker-only runtime, so
            // an accidental client import can't pull worker code into the bundle.
            const clientSource = (await callLoad(plugin, RESOLVED_LUNORA_WORKER_ID, "client")) as string;

            expect(clientSource).not.toContain("defineApp(");
            expect(clientSource).not.toContain("ShardDO");

            // Worker environment (named after the worker, not "client"): the real
            // composed entry.
            await expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID, "my-worker")).resolves.toContain("defineApp()");
        });

        it("threads the plugin's `shard` option into the composed worker it loads", async () => {
            expect.hasAssertions();

            // End to end through the plugin, because the composed entry is the
            // artifact that actually boots — constructing the shard class directly
            // is precisely what hid this gap.
            const plugin = frameworkComposePlugin(baseOptions({ shard: { reactiveCache: true } }), context("tanstack-start", "A"));

            await expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).resolves.toContain(".reactiveCache(true)");
        });

        it("bases the emitted imports on the resolved generated dir", async () => {
            expect.hasAssertions();

            // `generatedDir` is derived from `schemaDir`, never user-set — codegen
            // hardcodes `<schemaDir>/_generated`, so anything else pointed the
            // composed entry's imports at a directory nothing writes.
            const plugin = frameworkComposePlugin(baseOptions({ generatedDir: "server/_generated", schemaDir: "server" }), context("solid-start", "A"));
            const code = (await callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)) as string;

            expect(code).toContain('"/workspace/app/server/_generated/app"');
            expect(code).toContain('from "@solidjs/start/server-handler"');
        });
    });

    describe("no-op paths (class C and undetected must be untouched)", () => {
        it("does not resolve or load anything for a class-C (SPA) project", async () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("none", "C"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBeUndefined();
            await expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).resolves.toBeUndefined();
        });

        it("resolves and loads the virtual worker entry even when cloudflare:false (BYO Cloudflare plugin)", async () => {
            expect.hasAssertions();

            // `cloudflare: false` means "don't add @cloudflare/vite-plugin a second
            // time" — the user supplied it themselves (e.g. TanStack Start's vite.config
            // puts it first). It does NOT mean "disable the composed worker entry".
            // The virtual:lunora/worker must still resolve so @cloudflare/vite-plugin
            // (added by the user) can find the main entry declared in wrangler.jsonc.
            const plugin = frameworkComposePlugin(baseOptions({ cloudflare: false }), context("tanstack-start", "A"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBe(RESOLVED_LUNORA_WORKER_ID);
            expect(typeof (await callLoad(plugin, RESOLVED_LUNORA_WORKER_ID))).toBe("string");
        });

        it("does not resolve or load anything for an undetected project", async () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), {});

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBeUndefined();
            await expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).resolves.toBeUndefined();
        });
    });

    describe("buildWorkerEntrySource (pure)", () => {
        it("emits a TanStack Start entry that imports the server entry namespace and composes it", async () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).toContain('import * as ssrModule from "@tanstack/react-start/server-entry"');
            expect(code).toContain(".httpRouter(ssrModule.default)");
            expect(code).toContain("defineApp()");
        });

        it("omits allowUnauthenticatedShardAccess by default (shard access stays default-denied)", async () => {
            expect.hasAssertions();

            expect(buildWorkerEntrySource("tanstack-start", "./lunora/_generated")).not.toContain("allowUnauthenticatedShardAccess");
        });

        it("emits allowUnauthenticatedShardAccess through the worker-options escape hatch when opted in", async () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { allowUnauthenticatedShardAccess: true });

            expect(code).toContain(".extend(() => ({ allowUnauthenticatedShardAccess: true }))");
        });

        it("posix-ifies a Windows backslash generatedImportBase in the emitted specifiers", async () => {
            expect.hasAssertions();

            // On Windows `resolve()` yields backslash paths; embedded raw into a JS
            // string literal `\U` is an invalid unicode escape → SyntaxError, and
            // `\l`/`\a` silently vanish → unresolvable specifier. The emitter must
            // convert to forward slashes so the composed worker boots everywhere.
            const code = buildWorkerEntrySource("tanstack-start", String.raw`C:\Users\dev\app\lunora\_generated`, { classModules: ["containers"] });

            expect(code).toContain('"C:/Users/dev/app/lunora/_generated/app"');
            expect(code).toContain('"C:/Users/dev/app/lunora/_generated/containers"');
            // No stray backslash survives into the emitted module source.
            expect(code).not.toContain("\\");
        });

        it("throws for a framework without class-A wiring", async () => {
            expect.hasAssertions();

            // SvelteKit is class B — no class-A worker wiring exists for it.
            expect(() => buildWorkerEntrySource("sveltekit", "./lunora/_generated")).toThrow(/no class-A worker wiring/);
        });

        it("does not re-export any generated class module by default", async () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).not.toContain("/containers");
            expect(code).not.toContain("/workflows");
            expect(code).not.toContain("/agents");
        });

        it("re-exports the generated workflow and agent classes, not just containers", async () => {
            expect.hasAssertions();

            // Regression: only `containers` was ever forwarded, so a class-A app with
            // a `defineWorkflow` (or `defineAgent`) got a `class_name` in
            // wrangler.jsonc the bundle did not export and `wrangler deploy` hard-failed.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { classModules: ["agents", "containers", "workflows"] });

            expect(code).toContain('export * from "./lunora/_generated/agents"');
            expect(code).toContain('export * from "./lunora/_generated/containers"');
            expect(code).toContain('export * from "./lunora/_generated/workflows"');
        });

        it("re-exports the generated container classes when the project declares containers", async () => {
            expect.hasAssertions();

            // wrangler requires every container class_name to be exported by the
            // worker; a class-A app has no hand-written entry, so the composed one
            // must forward them.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { classModules: ["containers"] });

            expect(code).toContain('export * from "./lunora/_generated/containers"');
        });

        it("adds no shard-config call when none is declared", async () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).toContain(".httpRouter(ssrModule.default)\n    .build();");
        });

        it("bakes a declared shard config into the composed builder chain", async () => {
            expect.hasAssertions();

            // Regression: a class-A app has no worker entry, so it never called the
            // generated `defineApp()` builder — `cdc`, the reactive query cache and
            // the relation knobs were unreachable for TanStack Start / vinext /
            // React Router / SolidStart no matter what the app wanted.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", {
                classModules: [],
                allowUnauthenticatedShardAccess: false,
                shard: {
                    reactiveCache: { maxEntries: 250 },
                    relationExistsPushDown: "never",
                    cdc: true,
                },
            });

            // Keys sorted, so the emitted entry does not churn on literal ordering.
            expect(code).toContain('.cdc(true)\n    .reactiveCache({"maxEntries":250})\n    .relationExistsPushDown("never")');
        });

        it("wires ctx.scheduler into the composed entry when the binding is declared", async () => {
            expect.assertions(3);

            // `ctx.scheduler.runAfter` / `runAt` need a `SchedulerDO` namespace on
            // the worker, and a class-A app has no hand-written entry to add the
            // re-export to — so deferred dispatch was simply unavailable there.
            //
            // Keyed on the generated `scheduler` module, NOT the wrangler binding:
            // codegen writes that module off the same `hasScheduler` that decides
            // whether the builder has a `.scheduler()` method at all, so the call
            // cannot land on a builder that lacks it.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { classModules: ["scheduler"] });

            expect(code).toContain(".scheduler({ namespace: (env) => env.SCHEDULER })");
            // Forwarded by the ordinary star re-export, so the plugin hard-codes
            // no `@lunora/scheduler` specifier of its own.
            expect(code).toContain(`export * from "./lunora/_generated/scheduler";`);
            // Ordered before `.httpRouter(...)`, which `.build()` follows.
            expect(code.indexOf(".scheduler(")).toBeLessThan(code.indexOf(".httpRouter("));
        });

        it("composes nothing scheduler-shaped when the binding is absent", async () => {
            expect.assertions(2);

            // An app codegen wrote no `scheduler` module for has no scheduler, so
            // the entry must be byte-for-byte what it was — and must NOT name a
            // specifier the app has no dependency on.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { classModules: [] });

            expect(code).not.toContain(".scheduler(");
            expect(code).not.toContain("SchedulerDO");
        });

        describe("discovering the app hook in lunora.config.ts", () => {
            // `buildWorkerEntrySource` is pure and covered above; this drives the
            // `load()` hook against a real directory, which is the only place the
            // probe itself runs. Without it the seam was verified everywhere except
            // where it decides whether to fire.
            let projectRoot: string;

            beforeEach(() => {
                projectRoot = mkdtempSync(join(tmpdir(), "lunora-vite-app-config-"));
            });

            afterEach(() => {
                rmSync(projectRoot, { force: true, recursive: true });
            });

            const loadComposedEntry = async (): Promise<string> => {
                const plugin = frameworkComposePlugin(baseOptions({ projectRoot }), context("tanstack-start", "A"));

                return (await callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)) as string;
            };

            it("wires the hook when the config declares one", async () => {
                expect.assertions(2);

                writeFileSync(join(projectRoot, "lunora.config.ts"), `export default { app: (app) => app };\n`, "utf8");

                const code = await loadComposedEntry();

                expect(code).toContain("const app = configureApp(defineApp()");
                expect(code).toContain("const configureApp = lunoraConfig.app ?? ((builder) => builder);");
            });

            it("accepts named exports as well as a default export", async () => {
                expect.assertions(1);

                // `jiti`'s `interopDefault` reads a namespace through to its default
                // export, so both shapes arrive as the same object — there is no
                // second code path here, and rejecting one would be arbitrary.
                writeFileSync(join(projectRoot, "lunora.config.ts"), `export const app = (builder) => builder;\n`, "utf8");

                await expect(loadComposedEntry()).resolves.toContain("const app = configureApp(defineApp()");
            });

            it.each([
                ["declares no app hook", `export default { target: "cloudflare" };\n`],
                ["has an app that is not a function", `export default { app: "nope" };\n`],
                ["throws on load", `throw new Error("boom");\n`],
                ["does not parse", `export default { app: (app => app };\n`],
            ])("composes without a hook when the config %s", async (_label, source) => {
                expect.assertions(1);

                // Each of these would otherwise fail the BUNDLE with "does not
                // provide an export named …" against a virtual module — the least
                // debuggable error this plugin can produce. The config is LOADED to
                // decide, by the same loader the CLI uses, so a broken one degrades
                // to the composition it had before.
                writeFileSync(join(projectRoot, "lunora.config.ts"), source, "utf8");

                await expect(loadComposedEntry()).resolves.not.toContain("configureApp");
            });

            it("composes as before when there is no config file", async () => {
                expect.assertions(1);

                await expect(loadComposedEntry()).resolves.not.toContain("configureApp");
            });
        });

        it("composes the app's own builder calls through the config's app hook", async () => {
            expect.assertions(3);

            // The seam for calls this plugin cannot derive. `.scheduler(...)` is
            // mechanical; `.auth(...)` takes the app's better-auth options,
            // `.global(...)` its D1 writer, `.vectors(...)` its embedder — and
            // `resolveIdentity` is only ever set by `.auth()` / `.access()` /
            // `.extend()`, all builder calls a class-A app had no entry to write.
            const code = buildWorkerEntrySource("tanstack-start", "/app/lunora/_generated", { appConfigModule: "/app/lunora.config" });

            expect(code).toContain(`import lunoraConfig from "/app/lunora.config";`);
            expect(code).toContain("const app = configureApp(defineApp()");
            // The framework wiring stays ours: the app's calls land BETWEEN the
            // shard selector and `.httpRouter(...)` / `.build()`.
            expect(code.indexOf("configureApp(")).toBeLessThan(code.indexOf(".httpRouter("));
        });

        it("adds no blank-line churn for an app with no app config", async () => {
            expect.assertions(2);

            // The app-config import carries its own leading newline precisely so
            // an app without the module is unchanged. Interpolating it on its own
            // line instead left a stray blank line in every generated entry —
            // spurious HMR and a confusing diff on an unrelated release.
            const code = buildWorkerEntrySource("tanstack-start", "/app/lunora/_generated");

            expect(code).toContain(`import { defineApp } from "/app/lunora/_generated/app";\n\nconst app = defineApp()`);
            expect(code).not.toContain("\n\n\n");
        });

        it("forwards every generated class module as a star re-export", async () => {
            expect.assertions(1);

            // `@lunora/config`'s wrangler validator DECIDES which classes this
            // entry exports by reading these modules off `GENERATED_CLASS_MODULES`
            // (which it owns — this plugin re-exports it). A `class_name` outside
            // that set is reported as unbundlable, so "one star re-export per
            // module the project has" is the contract between the two, and it is
            // only visible in the emitted source.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", { classModules: [...GENERATED_CLASS_MODULES] });

            expect(GENERATED_CLASS_MODULES.every((module) => code.includes(`export * from "./lunora/_generated/${module}"`))).toBe(true);
        });

        it("imports nothing but the framework handler and the generated builder", async () => {
            expect.hasAssertions();

            // The composed entry used to import `@lunora/runtime` (or `lunorash/runtime`)
            // directly, which a `lunorash`-only install could not resolve under the
            // scoped specifier. Going through `_generated/app` — whose own imports
            // codegen already writes umbrella-aware — removes the question entirely.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).not.toContain("@lunora/runtime");
            expect(code).not.toContain("lunorash/runtime");
        });
    });
});
