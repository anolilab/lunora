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

import type { Plugin } from "vite";
import { afterAll, describe, expect, it } from "vitest";

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
const callLoad = (plugin: Plugin, id: string, environment = "ssr"): unknown => {
    const hook = plugin.load;
    const run = typeof hook === "function" ? hook : hook?.handler;

    return run?.call({ environment: { name: environment } } as never, id, undefined as never);
};

describe("framework-compose-plugin", () => {
    describe("isAutoComposable", () => {
        it("is true for each known class-A framework", () => {
            expect.hasAssertions();

            expect(isAutoComposable(context("tanstack-start", "A"))).toBe(true);
            expect(isAutoComposable(context("react-router", "A"))).toBe(true);
            expect(isAutoComposable(context("solid-start", "A"))).toBe(true);
        });

        it("is false for class-B, class-C, and undetected projects", () => {
            expect.hasAssertions();

            expect(isAutoComposable(context("sveltekit", "B"))).toBe(false);
            expect(isAutoComposable(context("none", "C"))).toBe(false);
            expect(isAutoComposable({})).toBe(false);
        });
    });

    describe("resolveId / load (class A → composition)", () => {
        it("resolves the virtual worker id for a class-A project", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("tanstack-start", "A"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBe(RESOLVED_LUNORA_WORKER_ID);
            // Unrelated ids are never claimed.
            expect(callResolveId(plugin, "some-other-module")).toBeUndefined();
        });

        it("loads a composeWorker entry that routes _lunora to Lunora and falls through to the framework SSR handler", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("react-router", "A"));
            const source = callLoad(plugin, RESOLVED_LUNORA_WORKER_ID);

            expect(typeof source).toBe("string");

            const code = source as string;

            // Composition is via composeWorker with an httpRouter seam — the
            // worker that routes /_lunora/* to Lunora and everything else to the
            // framework handler (precedence enforced inside @lunora/runtime).
            expect(code).toContain("composeWorker(");
            expect(code).toContain("httpRouter:");
            // React Router wiring: createRequestHandler over its virtual build.
            expect(code).toContain('from "react-router"');
            expect(code).toContain("virtual:react-router/server-build");
            // Generated artifacts are wired in via ABSOLUTE paths (projectRoot +
            // generatedDir). Virtual modules have no real filesystem path so
            // relative specifiers like "./lunora/_generated/..." can't be resolved
            // by Vite/rolldown — absolute paths work in all bundler environments.
            // baseOptions() uses projectRoot="/workspace/app", generatedDir="lunora/_generated".
            expect(code).toContain('"/workspace/app/lunora/_generated/functions"');
            expect(code).toContain("createShardDO()");
            expect(code).toContain("shardDO: env.SHARD");
        });

        it("emits a worker-free stub in the client environment but the real entry in the worker environment", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("react-router", "A"));

            // Browser environment: a stub with none of the worker-only runtime, so
            // an accidental client import can't pull worker code into the bundle.
            const clientSource = callLoad(plugin, RESOLVED_LUNORA_WORKER_ID, "client") as string;

            expect(clientSource).not.toContain("composeWorker(");
            expect(clientSource).not.toContain("createShardDO");

            // Worker environment (named after the worker, not "client"): the real
            // composed entry.
            expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID, "my-worker")).toContain("composeWorker(");
        });

        it("honours a custom generatedDir in the emitted imports", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions({ generatedDir: "server/gen" }), context("solid-start", "A"));
            const code = callLoad(plugin, RESOLVED_LUNORA_WORKER_ID) as string;

            // Absolute path: projectRoot + custom generatedDir
            expect(code).toContain('"/workspace/app/server/gen/functions"');
            expect(code).toContain('from "@solidjs/start/server-handler"');
        });
    });

    describe("no-op paths (class C and undetected must be untouched)", () => {
        it("does not resolve or load anything for a class-C (SPA) project", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), context("none", "C"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBeUndefined();
            expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).toBeUndefined();
        });

        it("resolves and loads the virtual worker entry even when cloudflare:false (BYO Cloudflare plugin)", () => {
            expect.hasAssertions();

            // `cloudflare: false` means "don't add @cloudflare/vite-plugin a second
            // time" — the user supplied it themselves (e.g. TanStack Start's vite.config
            // puts it first). It does NOT mean "disable the composed worker entry".
            // The virtual:lunora/worker must still resolve so @cloudflare/vite-plugin
            // (added by the user) can find the main entry declared in wrangler.jsonc.
            const plugin = frameworkComposePlugin(baseOptions({ cloudflare: false }), context("tanstack-start", "A"));

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBe(RESOLVED_LUNORA_WORKER_ID);
            expect(typeof callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).toBe("string");
        });

        it("does not resolve or load anything for an undetected project", () => {
            expect.hasAssertions();

            const plugin = frameworkComposePlugin(baseOptions(), {});

            expect(callResolveId(plugin, LUNORA_WORKER_VIRTUAL_ID)).toBeUndefined();
            expect(callLoad(plugin, RESOLVED_LUNORA_WORKER_ID)).toBeUndefined();
        });
    });

    describe("buildWorkerEntrySource (pure)", () => {
        it("emits a TanStack Start entry that imports the server entry namespace and composes it", () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).toContain('import * as ssrModule from "@tanstack/react-start/server-entry"');
            expect(code).toContain("httpRouter: ssrModule.default");
            expect(code).toContain("composeWorker(");
        });

        it("omits allowUnauthenticatedShardAccess by default (shard access stays default-denied)", () => {
            expect.hasAssertions();

            expect(buildWorkerEntrySource("tanstack-start", "./lunora/_generated")).not.toContain("allowUnauthenticatedShardAccess");
        });

        it("emits allowUnauthenticatedShardAccess into composeWorker when opted in", () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", false, false, true);

            expect(code).toContain("allowUnauthenticatedShardAccess: true,");
        });

        it("posix-ifies a Windows backslash generatedImportBase in the emitted specifiers", () => {
            expect.hasAssertions();

            // On Windows `resolve()` yields backslash paths; embedded raw into a JS
            // string literal `\U` is an invalid unicode escape → SyntaxError, and
            // `\l`/`\a` silently vanish → unresolvable specifier. The emitter must
            // convert to forward slashes so the composed worker boots everywhere.
            const code = buildWorkerEntrySource("tanstack-start", String.raw`C:\Users\dev\app\lunora\_generated`, true);

            expect(code).toContain('"C:/Users/dev/app/lunora/_generated/functions"');
            expect(code).toContain('"C:/Users/dev/app/lunora/_generated/containers"');
            // No stray backslash survives into the emitted module source.
            expect(code).not.toContain("\\");
        });

        it("throws for a framework without class-A wiring", () => {
            expect.hasAssertions();

            // SvelteKit is class B — no class-A worker wiring exists for it.
            expect(() => buildWorkerEntrySource("sveltekit", "./lunora/_generated")).toThrow(/no class-A worker wiring/);
        });

        it("does not re-export the generated container classes by default", () => {
            expect.hasAssertions();

            expect(buildWorkerEntrySource("tanstack-start", "./lunora/_generated")).not.toContain("/containers");
        });

        it("re-exports the generated container classes when the project declares containers", () => {
            expect.hasAssertions();

            // wrangler requires every container class_name to be exported by the
            // worker; a class-A app has no hand-written entry, so the composed one
            // must forward them.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", true);

            expect(code).toContain('export * from "./lunora/_generated/containers"');
        });

        it("imports the runtime from the granular `@lunora/runtime` by default", () => {
            expect.hasAssertions();

            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated");

            expect(code).toContain('import { composeWorker } from "@lunora/runtime"');
        });

        it("imports the runtime via the umbrella subpath when the project uses `lunorash`", () => {
            expect.hasAssertions();

            // A `lunorash`-only install (the starter-template default) does not expose
            // the bare `@lunora/runtime` specifier, so the composed worker must reach
            // the runtime through the umbrella subpath instead.
            const code = buildWorkerEntrySource("tanstack-start", "./lunora/_generated", false, true);

            expect(code).toContain('import { composeWorker } from "lunorash/runtime"');
            expect(code).not.toContain('from "@lunora/runtime"');
        });
    });

    describe("umbrella-aware runtime import (scaffolded project)", () => {
        // Regression for the dev-server boot failure
        // (`Cannot find module '@lunora/runtime' imported from 'virtual:lunora/worker'`):
        // a `lunorash`-only install — the starter-template default — cannot resolve the
        // bare `@lunora/runtime`, so the composed worker must reach the runtime through
        // the umbrella subpath. This drives the REAL plugin path (`projectUsesUmbrella`
        // reading an actual scaffolded `package.json`), exactly as a project boot would,
        // so a regression in the detection — not just the pure emitter — is caught.
        const dirs: string[] = [];

        const scaffold = (pkg: Record<string, unknown>): string => {
            const dir = mkdtempSync(join(tmpdir(), "lunora-compose-"));

            writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
            dirs.push(dir);

            return dir;
        };

        afterAll(() => {
            for (const dir of dirs) {
                rmSync(dir, { force: true, recursive: true });
            }
        });

        it("imports the runtime via `lunorash/runtime` when the scaffolded project depends on the umbrella", () => {
            expect.hasAssertions();

            const projectRoot = scaffold({ dependencies: { lunorash: "^1.0.0" }, name: "umbrella-app" });
            const plugin = frameworkComposePlugin(baseOptions({ projectRoot }), context("tanstack-start", "A"));
            const code = callLoad(plugin, RESOLVED_LUNORA_WORKER_ID) as string;

            expect(code).toContain('import { composeWorker } from "lunorash/runtime"');
            expect(code).not.toContain('from "@lunora/runtime"');
        });

        it("imports the granular `@lunora/runtime` when the scaffolded project uses scoped packages", () => {
            expect.hasAssertions();

            const projectRoot = scaffold({ dependencies: { "@lunora/server": "^1.0.0" }, name: "granular-app" });
            const plugin = frameworkComposePlugin(baseOptions({ projectRoot }), context("tanstack-start", "A"));
            const code = callLoad(plugin, RESOLVED_LUNORA_WORKER_ID) as string;

            expect(code).toContain('import { composeWorker } from "@lunora/runtime"');
        });
    });
});
