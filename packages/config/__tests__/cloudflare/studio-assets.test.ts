import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerBindings } from "../../src/cloudflare/apply-bindings";
import { reconcileStudioAssets } from "../../src/cloudflare/reconcile-project";
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

/** A Worker composed with the generated app, whose loaders read the documents through the binding. */
const COMPOSED_ENTRY = `import { defineApp } from "../lunora/_generated/app";\n\nexport default defineApp().build();\n`;

/** A hand-written `createWorker` entry, the Expo example's shape: it imports the spec itself and never reads `ASSETS`. */
const HAND_WRITTEN_ENTRY = [
    `import { createWorker } from "lunorash/runtime";`,
    ``,
    `const openApiSpec = () => import("../lunora/_generated/openapi").then((module) => module.openApiSpec);`,
    ``,
    `export default { fetch: (request: Request, env: never, ctx: never) => createWorker({ openApiSpec }).fetch(request, env, ctx) };`,
    ``,
].join("\n");

const writeEntry = (source: string): void => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "server.ts"), source, "utf8");
};

const writeProject = (wrangler: Record<string, unknown>, dependencies: Record<string, string> = {}, entry: string = COMPOSED_ENTRY): void => {
    writeEntry(entry);
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
            ["a legacy Workers Sites block", {}, { site: { bucket: "./public" } }],
            ["an environment's legacy Workers Sites block", {}, { env: { staging: { site: { bucket: "./public" } } } }],
            ["a KV namespace already bound as ASSETS", {}, { kv_namespaces: [{ binding: "ASSETS", id: "abc" }] }],
            ["a service already bound as ASSETS, beside the block Lunora wrote", {}, { assets: OWNED, services: [{ binding: "ASSETS", service: "cdn" }] }],
            // The top-level block is inheritable, so production would get a second `ASSETS`.
            ["an environment's KV namespace bound as ASSETS", {}, { env: { production: { kv_namespaces: [{ binding: "ASSETS", id: "abc" }] } } }],
            ["an environment's var named ASSETS, beside the block Lunora wrote", {}, { assets: OWNED, env: { staging: { vars: { ASSETS: "cdn" } } } }],
        ])("keeps them in the bundle for %s", (_label, dependencies: Record<string, string>, wrangler: Record<string, unknown>) => {
            expect.assertions(1);

            writeProject(wrangler, dependencies);

            expect(studioAssetsPlan(root, { main: "src/server.ts", ...wrangler })).toBeUndefined();
        });

        it("keeps them in the bundle for a hand-written entry, which never reads the binding", () => {
            expect.assertions(1);

            writeProject({}, {}, HAND_WRITTEN_ENTRY);

            expect(studioAssetsPlan(root, { main: "src/server.ts" })).toBeUndefined();
        });

        it("does not read a doc comment or a type-only import of defineApp as composing the app", () => {
            expect.assertions(1);

            writeProject({}, {}, `import type { defineApp } from "../lunora/_generated/app";\n\n/** Not built with \`defineApp()\`. */\n${HAND_WRITTEN_ENTRY}`);

            expect(studioAssetsPlan(root, { main: "src/server.ts" })).toBeUndefined();
        });

        it.each(["node", "celld"])("keeps them in the bundle on %s, which has no Workers Static Assets", (target) => {
            expect.assertions(1);

            writeProject({});

            expect(studioAssetsPlan(root, { main: "src/server.ts" }, target)).toBeUndefined();
        });

        it("keeps them in the bundle when lunora.config.* declares another target and none is passed", () => {
            expect.assertions(1);

            writeProject({});
            writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

            expect(studioAssetsPlan(root, { main: "src/server.ts" })).toBeUndefined();
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

        // The Expo example committed this block: its entry imports the spec itself, and a fresh clone has no `.lunora/`.
        it("removes the block it wrote from a hand-written entry, and creates no assets directory", () => {
            expect.assertions(3);

            writeProject({ assets: OWNED }, {}, HAND_WRITTEN_ENTRY);

            const result = reconcileWranglerBindings(root, inferred());

            expect(readWrangler()["assets"]).toBeUndefined();
            expect(result.updated).toContain("assets (Studio documents block removed)");
            expect(existsSync(join(root, STUDIO_ASSETS_DIRECTORY))).toBe(false);
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

        // `lunora dev --no-codegen` writes the block here and nothing writes the documents; wrangler refuses a missing directory.
        it("creates the assets directory the block points at, also when the block is already there", () => {
            expect.assertions(4);

            writeProject({});
            reconcileWranglerBindings(root, inferred());

            expect(readWrangler()["assets"]).toStrictEqual(OWNED);
            expect(existsSync(join(root, STUDIO_ASSETS_DIRECTORY))).toBe(true);

            // A fresh clone: the block is committed, `.lunora/` is gitignored.
            rmSync(join(root, ".lunora"), { force: true, recursive: true });

            expect(reconcileWranglerBindings(root, inferred()).changed).toBe(false);
            expect(existsSync(join(root, STUDIO_ASSETS_DIRECTORY))).toBe(true);
        });

        it("creates no assets directory when the documents stay bundled", () => {
            expect.assertions(1);

            writeProject({}, { "@lunora/vite": "*" });
            reconcileWranglerBindings(root, inferred());

            expect(existsSync(join(root, STUDIO_ASSETS_DIRECTORY))).toBe(false);
        });
    });

    describe(wranglerCodegenInputs, () => {
        it("hands codegen the binding and the directory, relative to the project root", () => {
            expect.assertions(1);

            writeProject({});

            expect(wranglerCodegenInputs(root).studioAssets).toStrictEqual({ binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY });
        });

        it("follows an explicit target over the one lunora.config.* declares", () => {
            expect.assertions(2);

            writeProject({});
            writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

            expect(wranglerCodegenInputs(root).studioAssets).toBeUndefined();
            expect(wranglerCodegenInputs(root, "cloudflare").studioAssets).toStrictEqual({ binding: "ASSETS", directory: STUDIO_ASSETS_DIRECTORY });
        });

        it("hands codegen nothing for a Vite project", () => {
            expect.assertions(1);

            writeProject({}, { "@lunora/vite": "*" });

            expect(wranglerCodegenInputs(root).studioAssets).toBeUndefined();
        });
    });

    describe(reconcileStudioAssets, () => {
        const logger = { info: () => {}, warn: () => {} };
        const wranglerPath = (): string => join(root, "wrangler.jsonc");
        const documentsDirectory = (): string => join(root, STUDIO_ASSETS_DIRECTORY, "_lunora", "studio");

        it("adds the owned block a plain wrangler deploy needs, keeping the file's comments, and changes nothing on a second run", () => {
            expect.assertions(3);

            writeProject({});
            writeFileSync(wranglerPath(), `// the app's Worker\n${readFileSync(wranglerPath(), "utf8")}`, "utf8");

            reconcileStudioAssets(root, "cloudflare", logger);

            const once = readFileSync(wranglerPath(), "utf8");

            expect(once.startsWith("// the app's Worker\n")).toBe(true);
            expect(readWrangler()["assets"]).toStrictEqual(OWNED);

            reconcileStudioAssets(root, "cloudflare", logger);

            expect(readFileSync(wranglerPath(), "utf8")).toBe(once);
        });

        it("creates the directory the block points at when lunora.config.* names another target and cloudflare is passed", () => {
            expect.assertions(2);

            writeProject({});
            writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

            reconcileStudioAssets(root, "cloudflare", logger);

            expect(readWrangler()["assets"]).toStrictEqual(OWNED);
            expect(existsSync(join(root, STUDIO_ASSETS_DIRECTORY))).toBe(true);
        });

        it("leaves a user's own assets block byte for byte", () => {
            expect.assertions(1);

            writeProject({ assets: { binding: "STATIC", directory: "./public", not_found_handling: "single-page-application" } });

            const before = readFileSync(wranglerPath(), "utf8");

            reconcileStudioAssets(root, "cloudflare", logger);

            expect(readFileSync(wranglerPath(), "utf8")).toBe(before);
        });

        it("writes nothing for another target", () => {
            expect.assertions(1);

            writeProject({});

            const before = readFileSync(wranglerPath(), "utf8");

            reconcileStudioAssets(root, "node", logger);

            expect(readFileSync(wranglerPath(), "utf8")).toBe(before);
        });

        it("writes nothing when no target is passed and lunora.config.* declares another", () => {
            expect.assertions(1);

            writeProject({});
            writeFileSync(join(root, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

            const before = readFileSync(wranglerPath(), "utf8");

            reconcileStudioAssets(root, undefined, logger);

            expect(readFileSync(wranglerPath(), "utf8")).toBe(before);
        });

        it("deletes the documents an earlier run wrote once the block is no longer Lunora's, and nothing else there", () => {
            expect.assertions(4);

            // The owned block, edited so the asset router answers `/_lunora/studio/*` before the Worker.
            writeProject({ assets: { ...OWNED, run_worker_first: false } });
            mkdirSync(documentsDirectory(), { recursive: true });

            for (const name of ["architecture.json", "openapi.json", "openrpc.json", "notes.json"]) {
                writeFileSync(join(documentsDirectory(), name), "{}", "utf8");
            }

            reconcileStudioAssets(root, "cloudflare", logger);

            expect(existsSync(join(documentsDirectory(), "architecture.json"))).toBe(false);
            expect(existsSync(join(documentsDirectory(), "openapi.json"))).toBe(false);
            expect(existsSync(join(documentsDirectory(), "openrpc.json"))).toBe(false);
            expect(existsSync(join(documentsDirectory(), "notes.json"))).toBe(true);
        });
    });
});
