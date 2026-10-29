import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import type { DevProcessSpawner } from "@lunora/config";
import { wranglerCodegenInputs } from "@lunora/config/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { runDeployCommand } from "../../src/commands/deploy/handler";
import { runPrepareCommand } from "../../src/commands/prepare/handler";
import type { VerifyCommandData } from "../../src/commands/verify/handler";
import { execute as verify } from "../../src/commands/verify/handler";
import type { VerifyOptions } from "../../src/commands/verify/index";
import runLazySmokeLoad from "../../src/util/lazy-smoke-load";
import { createRecordingSpawner } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

vi.mock(import("../../src/util/lazy-smoke-load"), () => {
    return { default: vi.fn<() => Promise<string | undefined>>(async () => undefined) };
});

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../codegen/__tests__/fixtures/simple/lunora");
const logger = { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };

describe("lazy deployment", () => {
    let projectRoot: string;

    beforeEach(() => {
        vi.stubEnv("LUNORA_LAZY_FUNCTIONS", "");
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-deployment-"));
        cpSync(fixtureRoot, join(projectRoot, "lunora"), { recursive: true });
        writeFileSync(
            join(projectRoot, "wrangler.jsonc"),
            JSON.stringify({
                compatibility_date: "2026-10-01",
                compatibility_flags: ["nodejs_compat", "web_socket_auto_reply_to_close"],
                d1_databases: [{ binding: "DB", database_name: "test", database_id: "actual-db-id" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                main: "src/index.ts",
                migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
                name: "lazy-deployment-test",
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(projectRoot, { force: true, recursive: true });
    });

    describe.each([
        { name: "deploy", run: runDeployCommand },
        { name: "build", run: runBuildCommand },
        { name: "prepare", run: runPrepareCommand },
    ])("$name lazy regeneration", ({ run }) => {
        it.each([
            { lazyFunctions: undefined, environment: "", enabled: false },
            { lazyFunctions: false, environment: "", enabled: false },
            { lazyFunctions: true, environment: "", enabled: true },
            { lazyFunctions: undefined, environment: "1", enabled: true },
            { lazyFunctions: false, environment: " True ", enabled: true },
            { lazyFunctions: undefined, environment: "false", enabled: false },
            { lazyFunctions: true, environment: "0", enabled: true },
        ])("regenerates with lazyFunctions=$lazyFunctions and environment=$environment", async ({ lazyFunctions, environment, enabled }) => {
            expect.assertions(5);

            vi.stubEnv("LUNORA_LAZY_FUNCTIONS", environment);

            runCodegen({ lazyFunctions: true, projectRoot, ...wranglerCodegenInputs(projectRoot) });
            writeFileSync(
                join(projectRoot, "lunora", "messages.ts"),
                'import { query } from "@lunora/server";\nexport const latest = query({ handler: async () => [] });\n',
            );
            const { spawner } = createRecordingSpawner();
            const options = { cwd: projectRoot, dryRun: true, interactive: false, lazyFunctions, logger, spawner, strictAdvisories: false };
            const result = await run(options);
            const generated = join(projectRoot, "lunora", "_generated");
            const functions = readFileSync(join(generated, "functions.ts"), "utf8");

            expect(result.code).toBe(0);
            expect(functions.includes("export const LUNORA_FUNCTION_MANIFEST")).toBe(enabled);
            expect(existsSync(join(generated, "fn", "lunora_messages_0.ts"))).toBe(enabled);
            expect(functions).toContain("messages:latest");
            expect(functions).not.toContain("messages:list");
        });
    });

    describe("verify lazy metadata gate", () => {
        it.each([
            { lazyFunctions: undefined, environment: "", enabled: false },
            { lazyFunctions: false, environment: "", enabled: false },
            { lazyFunctions: true, environment: "", enabled: true },
            { lazyFunctions: undefined, environment: "1", enabled: true },
            { lazyFunctions: false, environment: "true", enabled: true },
            { lazyFunctions: undefined, environment: "0", enabled: false },
        ])("checks lazyFunctions=$lazyFunctions and environment=$environment without writing", async ({ lazyFunctions, environment, enabled }) => {
            expect.assertions(3);

            vi.stubEnv("LUNORA_LAZY_FUNCTIONS", environment);

            writeFileSync(
                join(projectRoot, "lunora", "messages.ts"),
                'import { query } from "@lunora/server";\nconst base = query.expose({ rest: enabled });\nexport const list = base.query(() => []);\n',
            );
            const result = await runExecute<VerifyOptions, VerifyCommandData>(verify, {
                commandName: "verify",
                cwd: projectRoot,
                options: { format: "json", lazyFunctions, strictAdvisories: false, typecheck: false },
            });

            expect(result.code).toBe(enabled ? 1 : 0);
            expect(result.document?.data?.errors.join("\n").includes("lazy function registry needs literal")).toBe(enabled);
            expect(existsSync(join(projectRoot, "lunora", "_generated"))).toBe(false);
        });
    });

    describe("lazy smoke-load gate", () => {
        it.each([
            { lazyFunctions: true, smokeLoad: undefined, called: true },
            { lazyFunctions: true, smokeLoad: true, called: true },
            { lazyFunctions: true, smokeLoad: false, called: false },
            // The generated registry decides whether there is anything to check, so `--prebuilt` is covered too.
            { lazyFunctions: false, smokeLoad: undefined, called: true },
        ])("runs the check=$called for lazyFunctions=$lazyFunctions smokeLoad=$smokeLoad", async ({ lazyFunctions, smokeLoad, called }) => {
            expect.assertions(2);

            vi.mocked(runLazySmokeLoad).mockClear();

            const { spawner } = createRecordingSpawner();
            const result = await runBuildCommand({ cwd: projectRoot, lazyFunctions, logger, smokeLoad, spawner, strictAdvisories: false });

            expect(result.code).toBe(0);
            expect(vi.mocked(runLazySmokeLoad)).toHaveBeenCalledTimes(called ? 1 : 0);
        });

        it("hands an injected smoke launcher to the check", async () => {
            expect.assertions(1);

            vi.mocked(runLazySmokeLoad).mockClear();
            const smokeLauncher = vi.fn<DevProcessSpawner>();
            const { spawner } = createRecordingSpawner();

            await runBuildCommand({ cwd: projectRoot, lazyFunctions: true, logger, smokeLauncher, spawner, strictAdvisories: false });

            expect(vi.mocked(runLazySmokeLoad)).toHaveBeenCalledWith(expect.objectContaining({ launcher: smokeLauncher }));
        });

        it("skips prepare's smoke check on --no-smoke-load, as build and deploy do", async () => {
            expect.assertions(2);

            vi.mocked(runLazySmokeLoad).mockClear();
            const { spawner } = createRecordingSpawner();
            const result = await runPrepareCommand({ cwd: projectRoot, lazyFunctions: true, logger, smokeLoad: false, spawner, strictAdvisories: false });

            expect(vi.mocked(runLazySmokeLoad)).not.toHaveBeenCalled();
            expect(result.code).toBe(0);
        });

        it("hands an injected smoke launcher to prepare's check", async () => {
            expect.assertions(1);

            vi.mocked(runLazySmokeLoad).mockClear();
            const smokeLauncher = vi.fn<DevProcessSpawner>();
            const { spawner } = createRecordingSpawner();

            await runPrepareCommand({ cwd: projectRoot, lazyFunctions: true, logger, smokeLauncher, spawner, strictAdvisories: false });

            expect(vi.mocked(runLazySmokeLoad)).toHaveBeenCalledWith(expect.objectContaining({ launcher: smokeLauncher }));
        });

        it("refuses prepare, the CI gate, when a lazy module fails to load", async () => {
            expect.assertions(2);

            vi.mocked(runLazySmokeLoad).mockResolvedValueOnce("1 of 3 lazy function(s) fail to load: posts:list: boom");

            const { spawner } = createRecordingSpawner();
            const result = await runPrepareCommand({ cwd: projectRoot, lazyFunctions: true, logger, spawner, strictAdvisories: false });

            expect(result.code).not.toBe(0);
            expect(result.error).toContain("fail to load");
        });

        it("refuses to build, before wrangler runs, when a lazy module fails to load", async () => {
            expect.assertions(3);

            vi.mocked(runLazySmokeLoad).mockResolvedValueOnce("1 of 3 lazy function(s) fail to load — posts:list: boom");

            const { calls, spawner } = createRecordingSpawner();
            const result = await runBuildCommand({ cwd: projectRoot, lazyFunctions: true, logger, spawner, strictAdvisories: false });

            expect(result.code).not.toBe(0);
            expect(result.error).toContain("fail to load");
            expect(calls).toHaveLength(0);
        });
    });
});
