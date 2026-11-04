import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectConfigProblems } from "../src/project-config-validate";
import { runCodegen } from "../src/run-codegen";

describe("lunora.config validation", () => {
    let projectRoot: string;
    let configPath: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-config-validate-"));
        configPath = join(projectRoot, "lunora.config.ts");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    const writeConfig = (source: string): void => {
        writeFileSync(configPath, source, "utf8");
    };

    it.each([
        "export default {};\n",
        `export default {
    advisor: { accept: [], minSeverity: "warn" },
    app: (app) => app,
    codegen: { exclude: ["seed/**"], lazyFunctions: true },
    durableObjects: { merge: false },
    remote: { kinds: ["d1"] },
    services: { gateway: { dir: "./services/gateway", entrypoint: "Gateway", rpc: false } },
    studio: { companion: true },
    target: "cloudflare",
} satisfies LunoraConfig;\n`,
        "const config = { remote: true, app(app) { return app; } };\nexport default config;\n",
        // Computed values are the readers' to report, not this check's.
        "export default { remote: process.env.REMOTE === '1', target: process.env.TARGET };\n",
        "export type Env = { DB: string };\nexport interface Extra { a: string }\n",
    ])("accepts a valid config (%#)", (source) => {
        expect.assertions(1);

        writeConfig(source);

        expect(projectConfigProblems(configPath)).toStrictEqual([]);
    });

    it("names an unknown top-level key with the closest valid one", () => {
        expect.assertions(1);

        writeConfig("export default { remot: true, target: 'cloudflare' };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `remot`. Did you mean `remote`? Valid keys: advisor, app, codegen, durableObjects, remote, services, studio, target.",
        ]);
    });

    it("names an unknown nested key, also inside a services entry", () => {
        expect.assertions(1);

        writeConfig("export default { codegen: { lazyFuntions: true }, services: { api: { dir: './api', entryPoint: 'Api' } } };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `codegen.lazyFuntions`. Did you mean `codegen.lazyFunctions`? Valid keys of `codegen`: exclude, lazyFunctions.",
            "unknown key `services.api.entryPoint`. Did you mean `services.api.entrypoint`? Valid keys of `services.api`: dir, entrypoint, rpc.",
        ]);
    });

    it.each([
        ['remote: "true"', '`remote` must be a boolean, got a string ("true").'],
        ["target: 1", "`target` must be a string, got a number (1)."],
        ["durableObjects: { merge: 'yes' }", "`durableObjects.merge` must be a boolean, got a string ('yes')."],
        ["app: 'app'", "`app` must be a function, got a string ('app')."],
        ["studio: true", "`studio` must be an object, got a boolean (true)."],
        ["services: { api: { dir: './api', rpc: true } }", "`services.api.rpc` must be `false`, got `true`; leave it out for an RPC binding."],
    ])("refuses %s", (member, problem) => {
        expect.assertions(1);

        writeConfig(`export default { ${member} };\n`);

        expect(projectConfigProblems(configPath)).toStrictEqual([problem]);
    });

    it("follows a const to the value it names", () => {
        expect.assertions(1);

        writeConfig("const remote = 'true';\nexport default { remote };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual(["`remote` must be a boolean, got a string ('true')."]);
    });

    it("checks the named keys around a spread", () => {
        expect.assertions(1);

        writeConfig("const base = {};\nexport default { ...base, traget: 'cloudflare' };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `traget`. Did you mean `target`? Valid keys: advisor, app, codegen, durableObjects, remote, services, studio, target.",
        ]);
    });

    it("stops codegen on an invalid config, listing every problem", () => {
        expect.assertions(1);

        cpSync(join(import.meta.dirname, "fixtures", "simple", "lunora"), join(projectRoot, "lunora"), { recursive: true });
        writeConfig("export default { remote: 'true', studoi: {} };\n");

        expect(() => runCodegen({ projectRoot, wranglerQueueProducers: [] })).toThrow(
            /lunora\.config\.ts is invalid:\n {2}- `remote` must be a boolean[^\n]*\n {2}- unknown key `studoi`\. Did you mean `studio`\?/u,
        );
    });
});
