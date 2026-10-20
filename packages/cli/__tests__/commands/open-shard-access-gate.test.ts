import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { runDeployCommand } from "../../src/commands/deploy/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

// A passing deploy runs a full codegen pass; same headroom as the drift-gate suite.
vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

const silentLogger = (): { errors: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        logger: { error: (message) => errors.push(message), info: () => {}, success: () => {}, warn: (message) => warns.push(message) },
        warns,
    };
};

let workdir: string;

/** An app-config module the way the templates write it: the flag, with a "before deploying" comment beside it. */
const writeAppConfig = (flag: string): void => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
        join(workdir, "src", "app-options.ts"),
        `// Before deploying, replace allowUnauthenticatedShardAccess: true with a shard gate.\nexport const appOptions = () => ({\n    ${flag},\n});\n`,
        "utf8",
    );
};

describe("open-shard-access gate", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-open-shards-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("refuses a deploy that sets allowUnauthenticatedShardAccess: true, before anything is spawned", async () => {
        expect.assertions(4);

        writeAppConfig("allowUnauthenticatedShardAccess: true");

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
        expect(errors.some((line) => line.includes("open_shard_access") && line.includes("src/app-options.ts:3"))).toBe(true);
        expect(errors.some((line) => line.includes("authorizeShard"))).toBe(true);
    });

    it("refuses the flag written as a quoted key", async () => {
        expect.assertions(1);

        writeAppConfig('"allowUnauthenticatedShardAccess": true');

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("refuses an escaped spelling of the option name, which the raw text does not contain", async () => {
        expect.assertions(1);

        writeAppConfig(String.raw`"allowUnauthenticatedShardAccess": true`);

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("refuses the flag in a helper a CommonJS Vite config requires", async () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "vite.config.cjs"), `const options = require("./open-options.cjs");\nmodule.exports = { plugins: [options] };\n`, "utf8");
        writeFileSync(join(workdir, "open-options.cjs"), `module.exports = { allowUnauthenticatedShardAccess: true };\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("refuses the flag in a module that a source file imports from outside the scanned folders", async () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "src"), { recursive: true });
        mkdirSync(join(workdir, "shared"), { recursive: true });
        writeFileSync(join(workdir, "shared", "app.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");
        writeFileSync(join(workdir, "src", "worker.ts"), `import { options } from "../shared/app";\n\nexport default options;\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("refuses the flag set in a root lunora.config app hook", async () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora.config.ts"),
            `export default {\n    app: (app) => app.extend(() => ({\n        allowUnauthenticatedShardAccess: true,\n    })),\n};\n`,
            "utf8",
        );

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("lunora.config.ts:3"))).toBe(true);
    });

    it("refuses the flag set in a custom schemaDir", async () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "vite.config.ts"),
            `import { lunora } from "@lunora/vite";\n\nexport default { plugins: [lunora({ schemaDir: "backend" })] };\n`,
            "utf8",
        );
        mkdirSync(join(workdir, "backend"), { recursive: true });
        writeFileSync(join(workdir, "backend", "server.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("backend/server.ts:2"))).toBe(true);
    });

    it("deploys with --allow-open-shards, warning about the open posture", async () => {
        expect.assertions(3);

        writeAppConfig("allowUnauthenticatedShardAccess: true");

        const { calls, spawner } = createRecordingSpawner();
        const { logger, warns } = silentLogger();
        const result = await runDeployCommand({ allowOpenShards: true, cwd: workdir, logger, spawner });

        expect(result.code).toBe(0);
        expect(calls.length).toBeGreaterThan(0);
        expect(warns.some((line) => line.includes("--allow-open-shards"))).toBe(true);
    });

    it("ignores the name in comments and a literal false", async () => {
        expect.assertions(1);

        writeAppConfig("allowUnauthenticatedShardAccess: false");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("does not gate a flag set only in test or fixture files, which never ship", async () => {
        expect.assertions(2);

        mkdirSync(join(workdir, "lunora", "__tests__"), { recursive: true });
        writeFileSync(
            join(workdir, "lunora", "__tests__", "x.test.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );
        mkdirSync(join(workdir, "lunora", "__fixtures__"), { recursive: true });
        writeFileSync(
            join(workdir, "lunora", "__fixtures__", "app.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );
        mkdirSync(join(workdir, "lunora", "__mocks__"), { recursive: true });
        writeFileSync(
            join(workdir, "lunora", "__mocks__", "app.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );

        const { calls, spawner } = createRecordingSpawner();
        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner });

        expect(result.code).toBe(0);
        expect(calls.length).toBeGreaterThan(0);
    });

    it.each([
        ["a plain feature folder under src", join("src", "mocks", "app.ts")],
        ["a plain tests folder under lunora", join("lunora", "tests", "app.ts")],
    ])("still gates a flag in %s, which can ship", async (_label, file) => {
        expect.assertions(1);

        mkdirSync(join(workdir, file, ".."), { recursive: true });
        writeFileSync(join(workdir, file), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it.each(["allowUnauthenticatedShardAccess: true", '["allowUnauthenticatedShardAccess"]: true', "get allowUnauthenticatedShardAccess() { return true }"])(
        "refuses the open-shard option written as %s",
        async (member) => {
            expect.assertions(1);

            writeAppConfig(member);

            const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(result.code).toBe(EXIT_CODE.USAGE);
        },
    );

    it("follows a symlinked source folder, which codegen does too", async () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "outside"), { recursive: true });
        writeFileSync(join(workdir, "outside", "app.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");
        symlinkSync(join(workdir, "outside"), join(workdir, "lunora", "linked"));

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("survives a self-referential link and still gates the flag beside it", async () => {
        expect.assertions(1);

        symlinkSync("loop", join(workdir, "lunora", "loop"));
        writeAppConfig("allowUnauthenticatedShardAccess: true");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it.each(["src/app.test.js", "src/app.spec.mjs", "src/app.test.jsx"])("does not gate a flag in the test file %s", async (file) => {
        expect.assertions(1);

        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, file), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("refuses the flag in a root Wrangler entrypoint outside src/", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER.replace('"src/index.ts"', '"worker.ts"'), "utf8");
        writeFileSync(join(workdir, "worker.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("worker.ts:2"))).toBe(true);
    });

    it.each([
        "allowUnauthenticatedShardAccess: false as const",
        "allowUnauthenticatedShardAccess: (false)",
        "allowUnauthenticatedShardAccess: false satisfies boolean",
    ])("does not gate a literal false wrapped in a TypeScript assertion or parentheses: %s", async (flag) => {
        expect.assertions(1);

        writeAppConfig(flag);

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("refuses the flag in a root module the Vite config imports", async () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "vite.config.ts"),
            `import { openOptions } from "./open-options";\n\nexport default { plugins: [openOptions()] };\n`,
            "utf8",
        );
        writeFileSync(join(workdir, "open-options.ts"), `export const openOptions = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("open-options.ts:2"))).toBe(true);
    });

    it.each([
        "options.allowUnauthenticatedShardAccess = true;",
        'options["allowUnauthenticatedShardAccess"] = someValue;',
        "options.allowUnauthenticatedShardAccess ??= true;",
        "options.allowUnauthenticatedShardAccess ||= true;",
    ])("refuses an assignment to the open-shard option: %s", async (statement) => {
        expect.assertions(1);

        writeAppConfig("");
        writeFileSync(join(workdir, "src", "options-setup.ts"), `export const options = {};\n${statement}\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("does not read a bundle inside the Lunora directory's dist folder, which inlines the runtime", async () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "lunora", "dist"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "dist", "bundle.js"), `export const options = { allowUnauthenticatedShardAccess: options.open };\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("does not read a build bundle the Vite config imports, which inlines the runtime", async () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "vite.config.ts"), `import bundle from "./dist/server.mjs";\n\nexport default { plugins: [bundle] };\n`, "utf8");
        mkdirSync(join(workdir, "dist"), { recursive: true });
        writeFileSync(join(workdir, "dist", "server.mjs"), `export default { options: { allowUnauthenticatedShardAccess: options.open } };\n`, "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("refuses the flag in the entrypoint of the environment being deployed", async () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            VALID_WRANGLER.replace('"main": "src/index.ts",', '"main": "src/index.ts",\n    "env": { "staging": { "main": "staging/worker.ts" } },'),
            "utf8",
        );
        mkdirSync(join(workdir, "staging"), { recursive: true });
        writeFileSync(join(workdir, "staging", "worker.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, env: "staging", logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("staging/worker.ts:2"))).toBe(true);
    });

    it("refuses the flag when its value is a variable, not a literal false", async () => {
        expect.assertions(2);

        writeAppConfig("allowUnauthenticatedShardAccess: open");
        writeFileSync(
            join(workdir, "src", "app-options.ts"),
            `const open = true;\nexport const appOptions = () => ({\n    allowUnauthenticatedShardAccess: open,\n});\n`,
            "utf8",
        );

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("src/app-options.ts:3"))).toBe(true);
    });

    it("refuses the flag in a declared service's entrypoint, which the deploy publishes first", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
        mkdirSync(join(workdir, "services", "parser", "src"), { recursive: true });
        writeFileSync(join(workdir, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`, "utf8");
        writeFileSync(
            join(workdir, "services", "parser", "src", "index.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("services/parser/src/index.ts:2"))).toBe(true);
    });

    it("refuses a service's environment-specific entrypoint when deploying that environment", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
        mkdirSync(join(workdir, "services", "parser", "src"), { recursive: true });
        writeFileSync(
            join(workdir, "services", "parser", "wrangler.jsonc"),
            `{ "name": "parser", "main": "src/index.ts", "env": { "production": { "main": "src/prod.ts" } } }\n`,
            "utf8",
        );
        writeFileSync(join(workdir, "services", "parser", "src", "index.ts"), `export const options = () => ({});\n`, "utf8");
        writeFileSync(
            join(workdir, "services", "parser", "src", "prod.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );

        const { errors, logger } = silentLogger();
        const result = await runDeployCommand({ cwd: workdir, env: "production", logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("services/parser/src/prod.ts:2"))).toBe(true);
    });

    it("does not gate a service the deploy does not publish, under --skip-services", async () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
        mkdirSync(join(workdir, "services", "parser", "src"), { recursive: true });
        writeFileSync(join(workdir, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`, "utf8");
        writeFileSync(
            join(workdir, "services", "parser", "src", "index.ts"),
            `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`,
            "utf8",
        );

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, skipServices: true, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });

    it("leaves wrangler.jsonc as it was when the open-shard gate blocks the deploy", async () => {
        expect.assertions(2);

        writeAppConfig("allowUnauthenticatedShardAccess: true");
        const before = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(before);
    });

    it("does not gate `lunora build`, which publishes nothing", async () => {
        expect.assertions(1);

        writeAppConfig("allowUnauthenticatedShardAccess: true");

        const result = await runBuildCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(0);
    });
});
