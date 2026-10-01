import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import withServiceWorkers from "../src/service-workers";

describe(withServiceWorkers, () => {
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

    it("adds each declared service as an auxiliary Worker and keeps one the user already lists", () => {
        expect.assertions(1);

        const user = { configPath: "services/parser/wrangler.jsonc", persistState: false };

        expect(withServiceWorkers({ auxiliaryWorkers: [user] }, root).auxiliaryWorkers).toStrictEqual([
            user,
            { configPath: join(root, "services", "gateway", "wrangler.jsonc") },
        ]);
    });

    it.each([
        ["no service is declared", ""],
        ["the declaration is unreadable", `const shared = {};\nexport default { services: { ...shared } };\n`],
    ])("returns the options untouched when %s", (_label, config) => {
        expect.assertions(1);

        writeFileSync(join(root, "lunora.config.ts"), config);

        const options = { persistState: false };

        expect(withServiceWorkers(options, root)).toBe(options);
    });
});
