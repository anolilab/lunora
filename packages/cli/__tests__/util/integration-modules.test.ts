import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import collectIntegrationModules from "../../src/util/integration-modules";

describe(collectIntegrationModules, () => {
    let cwd: string;

    const write = (path: string, content: string): void => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
    };

    const install = (...names: string[]): void => {
        for (const name of names) {
            write(join("node_modules", name, "package.json"), JSON.stringify({ name }));
        }
    };

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-integration-modules-"));
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    it("finds the package import()s in the files the entry loads, through the generated registry", () => {
        expect.assertions(1);

        install("@cloudflare/playwright", "mysql2", "postgres", "stripe");
        write(
            "src/server/index.ts",
            'import { wire } from "./wire.js";\nimport { app } from "../../lunora/_generated/app.js";\nexport { mysql } from "./db";\nexport default { app, wire };\n',
        );
        write("lunora/_generated/app.ts", 'export { functions as app } from "./functions.js";\nexport const auth = () => import("stripe");\n');
        write("lunora/_generated/functions.ts", 'export const functions = { integrations: () => import("../integrations.js") };\n');
        write(
            "src/server/wire.ts",
            'export const wire = { playwright: () => import("@cloudflare/playwright"), client: async () => (await import("stripe")).default };\n',
        );
        write("src/server/db/index.ts", 'export const mysql = async () => (await import("mysql2/promise")).createPool({});\n');
        write("lunora/integrations.ts", 'export const load = () => import("postgres");\n');

        expect(collectIntegrationModules(cwd, "src/server/index.ts")).toStrictEqual(["@cloudflare/playwright", "mysql2/promise", "postgres", "stripe"]);
    });

    it("leaves out files the Worker never loads, runtime modules, generated output and uninstalled packages", () => {
        expect.assertions(1);

        install("stripe", "react-dom", "vitest");
        write(
            "src/server/index.ts",
            'import type { Client } from "../client/app";\nexport const run = async () => [await import("node:crypto"), await import("cloudflare:workers"), await import("missing-sdk")];\n',
        );
        write("src/client/app.ts", 'export const render = () => import("react-dom");\n');
        write("lunora/_generated/app.ts", 'export const load = () => import("stripe");\n');
        // A colocated test sits in the schema directory, but nothing the Worker loads imports it.
        write("lunora/posts.test.ts", 'export const mocked = () => import("vitest");\n');

        expect(collectIntegrationModules(cwd, "src/server/index.ts")).toStrictEqual([]);
    });

    it("follows a relative import() into the module that loads the SDK", () => {
        expect.assertions(1);

        install("stripe");
        write("src/index.ts", 'export const later = () => import("./billing.js");\n');
        write("src/billing.ts", 'export const client = () => import("stripe");\n');

        expect(collectIntegrationModules(cwd, "src/index.ts")).toStrictEqual(["stripe"]);
    });
});
