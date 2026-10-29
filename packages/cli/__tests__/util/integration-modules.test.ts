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

    it("finds the package import()s reachable from the entry and the schema directory", () => {
        expect.assertions(1);

        install("@cloudflare/playwright", "mysql2", "postgres", "stripe");
        write("src/server/index.ts", 'import { wire } from "./wire.js";\nexport { mysql } from "./db";\nexport default wire;\n');
        write(
            "src/server/wire.ts",
            'export const wire = { playwright: () => import("@cloudflare/playwright"), client: async () => (await import("stripe")).default };\n',
        );
        write("src/server/db/index.ts", 'export const mysql = async () => (await import("mysql2/promise")).createPool({});\n');
        write("lunora/integrations.ts", 'export const load = () => import("postgres");\n');

        expect(collectIntegrationModules(cwd, "src/server/index.ts", "lunora")).toStrictEqual([
            "@cloudflare/playwright",
            "mysql2/promise",
            "postgres",
            "stripe",
        ]);
    });

    it("leaves out client code the entry does not reach, runtime modules, generated output and uninstalled packages", () => {
        expect.assertions(1);

        install("stripe", "react-dom");
        write(
            "src/server/index.ts",
            'import type { Client } from "../client/app";\nexport const run = async () => [await import("node:crypto"), await import("cloudflare:workers"), await import("missing-sdk")];\n',
        );
        write("src/client/app.ts", 'export const render = () => import("react-dom");\n');
        write("lunora/_generated/app.ts", 'export const load = () => import("stripe");\n');

        expect(collectIntegrationModules(cwd, "src/server/index.ts", "lunora")).toStrictEqual([]);
    });

    it("follows a relative import() into the module that loads the SDK", () => {
        expect.assertions(1);

        install("stripe");
        write("src/index.ts", 'export const later = () => import("./billing.js");\n');
        write("src/billing.ts", 'export const client = () => import("stripe");\n');

        expect(collectIntegrationModules(cwd, "src/index.ts", "lunora")).toStrictEqual(["stripe"]);
    });
});
