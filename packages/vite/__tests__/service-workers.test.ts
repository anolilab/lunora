import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigEnv, Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import serviceWorkersPlugin from "../src/service-workers";
import type { CloudflarePluginOptions } from "../src/types";

/** Run the plugin's `config` hook for `command`, returning the options it mutated. */
const run = (options: CloudflarePluginOptions, root: string, command: ConfigEnv["command"]): CloudflarePluginOptions => {
    const plugin: Plugin = serviceWorkersPlugin(options, root);

    (plugin.config as (config: object, env: ConfigEnv) => void)({}, { command, mode: "development" });

    return options;
};

describe(serviceWorkersPlugin, () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-service-workers-"));
        writeFileSync(
            join(root, "lunora.config.ts"),
            `export default { services: { parser: { dir: "./services/parser" }, gateway: { dir: "./services/gateway" } } };\n`,
        );

        for (const name of ["parser", "gateway"]) {
            mkdirSync(join(root, "services", name), { recursive: true });
            writeFileSync(join(root, "services", name, "wrangler.jsonc"), `{ "name": "${name}", "main": "src/index.ts" }\n`);
        }
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("adds each declared service as an auxiliary Worker on vite dev and keeps one the user already lists", () => {
        expect.assertions(1);

        const user = { configPath: "services/parser/wrangler.jsonc", persistState: false };

        expect(run({ auxiliaryWorkers: [user] }, root, "serve").auxiliaryWorkers).toStrictEqual([
            user,
            { configPath: join(root, "services", "gateway", "wrangler.jsonc") },
        ]);
    });

    it("adds none on vite build, where lunora deploy ships services from their own folders", () => {
        expect.assertions(1);

        expect(run({}, root, "build").auxiliaryWorkers).toBeUndefined();
    });

    it("adds a Worker bound under two keys once", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "lunora.config.ts"),
            `export default { services: { a: { dir: "./services/gateway", entrypoint: "A" }, b: { dir: "./services/gateway", entrypoint: "B" } } };\n`,
        );

        expect(run({}, root, "serve").auxiliaryWorkers).toStrictEqual([{ configPath: join(root, "services", "gateway", "wrangler.jsonc") }]);
    });

    it.each([
        ["no service is declared", ""],
        ["the declaration is unreadable", `const shared = {};\nexport default { services: { ...shared } };\n`],
    ])("adds none when %s", (_label, config) => {
        expect.assertions(1);

        writeFileSync(join(root, "lunora.config.ts"), config);

        expect(run({ persistState: false }, root, "serve")).toStrictEqual({ persistState: false });
    });
});
