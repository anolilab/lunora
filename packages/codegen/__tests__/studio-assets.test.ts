import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import { runCodegen } from "../src/index";
import baseOptions from "./emit-app-options";
import { makeFixtureWorkdir } from "./golden-fixtures";

/**
 * Studio's documents shipped as Workers Static Assets (`studioAssets`): the
 * generated worker reads them through the binding and never imports the
 * document modules, so wrangler's bundle leaves them out.
 */

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "simple");
const STUDIO = { binding: "ASSETS", directory: ".lunora/studio-assets" };

const allDocuments = { ...baseOptions, wantsArchitecture: true, wantsOpenApi: true, wantsOpenRpc: true };

describe("emitApp — Studio documents as assets", () => {
    it("reads each document through the binding and imports none of their modules", () => {
        expect.assertions(5);

        const source = emitApp({ ...allDocuments, studioAssetsBinding: "ASSETS" });

        expect(source).toContain('architecture: () => loadStudioDocument((env as Record<string, unknown>)["ASSETS"], "architecture"),');
        expect(source).toContain('openApiSpec: () => loadStudioDocument((env as Record<string, unknown>)["ASSETS"], "openapi"),');
        expect(source).toContain('openRpcSpec: () => loadStudioDocument((env as Record<string, unknown>)["ASSETS"], "openrpc"),');
        expect(source).not.toMatch(/import\("\.\/(?:architecture|openapi|openrpc)\.js"\)/u);
        expect(source).toMatch(/^import \{[^}]*\bloadStudioDocument\b[^}]*\} from "@lunora\/runtime";$/mu);
    });

    it("imports the modules, and not the asset reader, when the documents stay in the bundle", () => {
        expect.assertions(2);

        const source = emitApp(allDocuments);

        expect(source).toContain('openApiSpec: () => import("./openapi.js").then((module) => module.openApiSpec),');
        expect(source).not.toContain("loadStudioDocument");
    });
});

describe("runCodegen — Studio documents as assets", () => {
    let workdir: string | undefined;

    afterEach(() => {
        if (workdir !== undefined) {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("writes each document under _lunora/studio/ in the assets directory", () => {
        expect.assertions(3);

        workdir = makeFixtureWorkdir(fixtureRoot);
        runCodegen({ apiSpec: "both", lint: false, projectRoot: workdir, studioAssets: STUDIO, wranglerQueueProducers: [] });

        const studio = join(workdir, STUDIO.directory, "_lunora", "studio");

        expect(readFileSync(join(studio, "openapi.json"), "utf8")).toBe(readFileSync(join(workdir, "lunora", "_generated", "openapi.json"), "utf8"));
        expect(readFileSync(join(studio, "openrpc.json"), "utf8")).toBe(readFileSync(join(workdir, "lunora", "_generated", "openrpc.json"), "utf8"));
        // No module is declared, so there is no architecture manifest to ship.
        expect(existsSync(join(studio, "architecture.json"))).toBe(false);
    }, 300_000);

    it("removes a document the next run no longer emits", () => {
        expect.assertions(2);

        workdir = makeFixtureWorkdir(fixtureRoot);
        runCodegen({ apiSpec: "both", lint: false, projectRoot: workdir, studioAssets: STUDIO, wranglerQueueProducers: [] });
        runCodegen({ apiSpec: "openapi", lint: false, projectRoot: workdir, studioAssets: STUDIO, wranglerQueueProducers: [] });

        const studio = join(workdir, STUDIO.directory, "_lunora", "studio");

        expect(existsSync(join(studio, "openapi.json"))).toBe(true);
        expect(existsSync(join(studio, "openrpc.json"))).toBe(false);
    }, 300_000);

    it("keeps the documents as modules on a target without Workers Static Assets", () => {
        expect.assertions(2);

        workdir = makeFixtureWorkdir(fixtureRoot);

        const { generated } = runCodegen({ lint: false, projectRoot: workdir, studioAssets: STUDIO, target: "node", wranglerQueueProducers: [] });

        expect(generated.app).toContain('openApiSpec: () => import("./openapi.js").then((module) => module.openApiSpec),');
        expect(existsSync(join(workdir, STUDIO.directory))).toBe(false);
    }, 300_000);
});
