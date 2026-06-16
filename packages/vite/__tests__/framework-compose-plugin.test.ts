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
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import type { DetectedFramework, FrameworkClass } from "../src/detect-framework";
import frameworkComposePlugin, {
    buildWorkerEntrySource,
    isAutoComposable,
    LUNORA_WORKER_VIRTUAL_ID,
    RESOLVED_LUNORA_WORKER_ID,
} from "../src/framework-compose-plugin";
import type { LunoraPluginContext } from "../src/framework-detect-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

const baseOptions = (overrides: Partial<ResolvedLunoraPluginOptions> = {}): ResolvedLunoraPluginOptions => {
    return {
        apiSpec: "openapi",
        cloudflare: {},
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot: "/workspace/app",
        schemaDir: "lunora",
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

/** Call a plugin's `load` hook regardless of whether it is a fn or `{ handler }`. */
const callLoad = (plugin: Plugin, id: string): unknown => {
    const hook = plugin.load;
    const run = typeof hook === "function" ? hook : hook?.handler;

    return run?.call({} as never, id, undefined as never);
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
    });
});
