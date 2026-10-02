import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeServiceDevConfigs } from "../src/cloudflare/service-dev-config";

let workdir: string;

const writeService = (name: string, config: string): string => {
    const directory = join(workdir, "services", name);

    mkdirSync(directory, { recursive: true });

    const path = join(directory, "wrangler.jsonc");

    writeFileSync(path, config, "utf8");

    return path;
};

describe(materializeServiceDevConfigs, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-service-dev-config-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("hands back a service without a custom build as is, writing nothing", () => {
        expect.assertions(1);

        const path = writeService("parser", `{ "name": "parser", "main": "src/index.ts" }\n`);

        expect(materializeServiceDevConfigs([path]).configPaths).toStrictEqual([path]);
    });

    it("runs a relative build command in the service's folder, via a sibling copy with an absolute build.cwd", () => {
        expect.assertions(5);

        // The #934 shape: a Rust Worker built by its own script.
        const path = writeService(
            "rusty",
            `{
    // kept
    "name": "rusty",
    "main": "build/worker/shim.mjs",
    "build": { "command": "./build.sh" },
}
`,
        );
        const { cleanup, configPaths } = materializeServiceDevConfigs([path]);
        const [copy] = configPaths as [string];
        const text = readFileSync(copy, "utf8");

        // Beside the original, so `main` and friends still resolve against the service's folder.
        expect(dirname(copy)).toBe(dirname(path));
        expect(parseJsonc(text)).toStrictEqual({
            build: { command: "./build.sh", cwd: dirname(path) },
            main: "build/worker/shim.mjs",
            name: "rusty",
        });
        expect(text).toContain("// kept");

        cleanup();
        cleanup();

        expect(existsSync(copy)).toBe(false);
        expect(existsSync(path)).toBe(true);
    });

    it("resolves a relative build.cwd against the service's folder, not the process", () => {
        expect.assertions(1);

        const path = writeService("web", `{ "name": "web", "main": "dist/index.js", "build": { "command": "npm run build", "cwd": "./app" } }\n`);
        const { cleanup, configPaths } = materializeServiceDevConfigs([path]);

        expect(parseJsonc(readFileSync(configPaths[0] as string, "utf8")).build.cwd).toBe(join(dirname(path), "app"));

        cleanup();
    });

    it("leaves a service whose build.cwd is already absolute alone", () => {
        expect.assertions(1);

        const path = writeService(
            "pinned",
            `{ "name": "pinned", "main": "dist/index.js", "build": { "command": "make", "cwd": ${JSON.stringify(workdir)} } }\n`,
        );

        expect(materializeServiceDevConfigs([path]).configPaths).toStrictEqual([path]);
    });

    it("keeps the input order across services that do and do not need a copy", () => {
        expect.assertions(2);

        const plain = writeService("plain", `{ "name": "plain", "main": "src/index.ts" }\n`);
        const built = writeService("built", `{ "name": "built", "main": "dist/index.js", "build": { "command": "./build.sh" } }\n`);
        const { cleanup, configPaths } = materializeServiceDevConfigs([built, plain]);

        expect(configPaths[1]).toBe(plain);
        expect(dirname(configPaths[0] as string)).toBe(dirname(built));

        cleanup();
    });
});
