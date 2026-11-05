import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerBindings } from "../../src/cloudflare/reconcile-bindings";
import { isOwnedStudioAssets, STUDIO_ASSETS_DIRECTORY, studioAssetsPlan } from "../../src/cloudflare/studio-assets";
import { wranglerCodegenInputs } from "../../src/cloudflare/wrangler-codegen-inputs";
import type { InferredBindings } from "../../src/infer-bindings";

const OWNED = { binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY, run_worker_first: true };

/** Only what reconcile reads for the `assets` step; every other inference is off. */
const inferred = (): InferredBindings =>
    ({
        agents: [],
        containers: [],
        durableObjects: [{ binding: "SHARD", className: "ShardDO" }],
        queues: [],
        services: [],
        signals: [],
        workerRoutes: [],
        workflows: [],
    }) as unknown as InferredBindings;

let root: string;

const writeProject = (wrangler: Record<string, unknown>, dependencies: Record<string, string> = {}): void => {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ dependencies, name: "app" }, undefined, 4)}\n`, "utf8");
    writeFileSync(
        join(root, "wrangler.jsonc"),
        `${JSON.stringify(
            {
                compatibility_date: "2026-04-07",
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                main: "src/server.ts",
                migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
                name: "app",
                observability: { enabled: true },
                upload_source_maps: true,
                ...wrangler,
            },
            undefined,
            4,
        )}\n`,
        "utf8",
    );
};

const readWrangler = (): Record<string, unknown> => parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;

describe("studio documents as Workers Static Assets", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-studio-assets-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(studioAssetsPlan, () => {
        it("ships them as assets for a Cloudflare Worker wrangler bundles, with no assets block", () => {
            expect.assertions(2);

            writeProject({});

            expect(studioAssetsPlan(root, { main: "src/server.ts" })).toStrictEqual({ binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY });
            expect(studioAssetsPlan(root, { assets: OWNED, main: "src/server.ts" })).toStrictEqual({ binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY });
        });

        it.each([
            ["a Vite project", { "@lunora/vite": "*" }, {}],
            ["an Rsbuild project", { "@lunora/rspack": "*" }, {}],
            ["a framework project", { astro: "*" }, {}],
            ["the composed Vite entry", {}, { main: "virtual:lunora/worker" }],
            ["its own assets block", {}, { assets: { binding: "ASSETS", directory: "./public", run_worker_first: true } }],
            ["an environment's own assets block", {}, { env: { staging: { assets: { directory: "./dist" } } } }],
        ])("keeps them in the bundle for %s", (_label, dependencies: Record<string, string>, wrangler: Record<string, unknown>) => {
            expect.assertions(1);

            writeProject(wrangler, dependencies);

            expect(studioAssetsPlan(root, { main: "src/server.ts", ...wrangler })).toBeUndefined();
        });

        it.each(["node", "celld"])("keeps them in the bundle on %s, which has no Workers Static Assets", (target) => {
            expect.assertions(1);

            writeProject({});

            expect(studioAssetsPlan(root, { main: "src/server.ts" }, target)).toBeUndefined();
        });

        it("keeps them in the bundle for a root it cannot read as a project", () => {
            expect.assertions(1);

            expect(studioAssetsPlan(root, { main: "src/server.ts" })).toBeUndefined();
        });
    });

    describe("reconcile", () => {
        it("gives an API-only Worker the assets block, running the Worker first for every path", () => {
            expect.assertions(4);

            writeProject({});

            const result = reconcileWranglerBindings(root, inferred());

            expect(readWrangler()["assets"]).toStrictEqual(OWNED);
            expect(result.added).toContain("assets (Studio documents, run_worker_first: true)");
            // `true` covers Lunora's reserved paths, so the run_worker_first reconcile neither rewrites nor warns about it.
            expect(result.warnings.filter((warning) => warning.includes("run_worker_first"))).toStrictEqual([]);
            expect(reconcileWranglerBindings(root, inferred()).changed).toBe(false);
        });

        it.each([
            ["one sending /_lunora/* to the Worker", ["/_lunora/*", "/__lunora/*"]],
            ["one leaving /_lunora/* to the assets", ["/api/*"]],
            ["one taking part of /_lunora/* back", ["/_lunora/*", "/__lunora/*", "!/_lunora/studio/*"]],
        ])("leaves a project's own assets block alone, %s, and keeps the documents bundled", (_label, runWorkerFirst) => {
            expect.assertions(3);

            const assets = { binding: "ASSETS", directory: "./public", run_worker_first: runWorkerFirst };

            writeProject({ assets });
            reconcileWranglerBindings(root, inferred());

            expect(isOwnedStudioAssets(readWrangler()["assets"])).toBe(false);
            expect((readWrangler()["assets"] as Record<string, unknown>)["directory"]).toBe("./public");
            expect(wranglerCodegenInputs(root).studioAssets).toBeUndefined();
        });

        it("removes the block it wrote once the project builds with a bundler plugin", () => {
            expect.assertions(2);

            writeProject({ assets: OWNED }, { "@lunora/vite": "*" });

            const result = reconcileWranglerBindings(root, inferred());

            expect(readWrangler()["assets"]).toBeUndefined();
            expect(result.updated).toContain("assets (Studio documents block removed)");
        });

        it("keeps a block that differs from the one it writes", () => {
            expect.assertions(1);

            const edited = { ...OWNED, not_found_handling: "404-page" };

            writeProject({ assets: edited }, { "@lunora/vite": "*" });
            reconcileWranglerBindings(root, inferred());

            expect(readWrangler()["assets"]).toStrictEqual(edited);
        });

        it("writes nothing for another target", () => {
            expect.assertions(1);

            writeProject({});
            reconcileWranglerBindings(root, inferred(), { target: "node" });

            expect(readWrangler()["assets"]).toBeUndefined();
        });
    });

    describe(wranglerCodegenInputs, () => {
        it("hands codegen the binding and the directory, relative to the project root", () => {
            expect.assertions(1);

            writeProject({});

            expect(wranglerCodegenInputs(root).studioAssets).toStrictEqual({ binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY });
        });

        it("hands codegen nothing for a Vite project", () => {
            expect.assertions(1);

            writeProject({}, { "@lunora/vite": "*" });

            expect(wranglerCodegenInputs(root).studioAssets).toBeUndefined();
        });
    });
});
