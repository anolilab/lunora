import { cpSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { companionServiceBinding, readBoundServiceBindings, readServiceBindings, resolveServiceBindings } from "../src/discover/service-bindings";
import { runCodegen } from "../src/run-codegen";

const fixtureLunora = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "simple", "lunora");

describe("companion service binding", () => {
    let projectRoot: string;

    const writeConfig = (body: string): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), `export default ${body};\n`, "utf8");
    };

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-companion-binding-"));
        cpSync(fixtureLunora, join(projectRoot, "lunora"), { recursive: true });
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "shop", "main": "src/index.ts" }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("binds nothing while the flag is off", () => {
        expect.assertions(2);

        writeConfig("{ studio: { companion: false } }");

        expect(companionServiceBinding(projectRoot)).toBeUndefined();
        expect(readBoundServiceBindings(projectRoot).services).toStrictEqual([]);
    });

    it("binds ADVISOR_COMPANION to the generated companion Worker while the flag is on", () => {
        expect.assertions(1);

        writeConfig("{ studio: { companion: true } }");

        expect(companionServiceBinding(projectRoot)).toStrictEqual({
            binding: "ADVISOR_COMPANION",
            envWorkers: {},
            main: join(projectRoot, "lunora", "_generated", "companion", "src", "worker.ts"),
            name: "advisorCompanion",
            publicScopes: [],
            worker: "shop-advisor",
            wranglerPath: join(projectRoot, "lunora", "_generated", "companion", "wrangler.jsonc"),
        });
    });

    it("appends the companion to the bound list but never to the list user code sees", () => {
        expect.assertions(4);

        writeConfig("{ studio: { companion: true } }");

        const bound = readBoundServiceBindings(projectRoot).services.map((service) => service.name);

        expect(bound).toContain("advisorCompanion");
        // These feed `ctx.services`; the companion leaking in would expose `ctx.services.advisorCompanion`.
        expect(readServiceBindings(projectRoot).services.map((service) => service.name)).not.toContain("advisorCompanion");
        expect(resolveServiceBindings(projectRoot).map((service) => service.name)).not.toContain("advisorCompanion");
        expect(bound.at(-1)).toBe("advisorCompanion");
    });

    it("points at the folder runCodegen actually writes", () => {
        expect.assertions(2);

        writeConfig("{ studio: { companion: true } }");
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        const binding = companionServiceBinding(projectRoot);

        expect(existsSync(binding?.wranglerPath ?? "missing")).toBe(true);
        expect(existsSync(binding?.main ?? "missing")).toBe(true);
    });

    it("reads the Worker name from the top-level `name` only, not a nested or commented one", () => {
        expect.assertions(1);

        writeConfig("{ studio: { companion: true } }");
        writeFileSync(
            join(projectRoot, "wrangler.jsonc"),
            `{
    // "name": "commented"
    "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
    "workflows": [{ "name": "nightly", "binding": "WF", "class_name": "Nightly" }],
    "name": "shop",
}\n`,
            "utf8",
        );

        expect(companionServiceBinding(projectRoot)?.worker).toBe("shop-advisor");
    });

    it("reports a wrangler config without a top-level name, naming the file, instead of guessing", () => {
        expect.assertions(2);

        writeConfig("{ studio: { companion: true } }");
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "workflows": [{ "name": "nightly" }] }\n`, "utf8");

        expect(() => companionServiceBinding(projectRoot)).toThrow(join(projectRoot, "wrangler.jsonc"));
        expect(readBoundServiceBindings(projectRoot).error).toContain("no top-level");
    });

    it("refuses a wrangler.toml project rather than falling back to the folder name", () => {
        expect.assertions(1);

        writeConfig("{ studio: { companion: true } }");
        rmSync(join(projectRoot, "wrangler.jsonc"));
        writeFileSync(join(projectRoot, "wrangler.toml"), 'name = "shop"\n', "utf8");

        expect(() => companionServiceBinding(projectRoot)).toThrow("wrangler.toml");
    });

    it("follows a non-default lunora directory, and runCodegen writes where the binding points", () => {
        expect.assertions(3);

        renameSync(join(projectRoot, "lunora"), join(projectRoot, "backend"));
        writeConfig("{ studio: { companion: true } }");
        runCodegen({ lunoraDirectory: "backend", projectRoot, wranglerQueueProducers: [] });

        const binding = companionServiceBinding(projectRoot, "backend");

        expect(binding?.wranglerPath).toBe(join(projectRoot, "backend", "_generated", "companion", "wrangler.jsonc"));
        expect(existsSync(binding?.wranglerPath ?? "missing")).toBe(true);
        expect(readBoundServiceBindings(projectRoot, "backend").services.at(-1)?.main).toBe(binding?.main);
    });
});
