import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { wranglerCodegenInputs } from "@lunora/config/cloudflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { runDeployCommand } from "../../src/commands/deploy/handler";
import { runPrepareCommand } from "../../src/commands/prepare/handler";
import type { VerifyCommandData } from "../../src/commands/verify/handler";
import { execute as verify } from "../../src/commands/verify/handler";
import type { VerifyOptions } from "../../src/commands/verify/index";
import { createRecordingSpawner } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../codegen/__tests__/fixtures/simple/lunora");
const logger = { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };

describe("lazy deployment", () => {
    let projectRoot: string;

    beforeEach(() => {
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
        rmSync(projectRoot, { force: true, recursive: true });
    });

    describe.each([
        { name: "deploy", run: runDeployCommand },
        { name: "build", run: runBuildCommand },
        { name: "prepare", run: runPrepareCommand },
    ])("$name lazy regeneration", ({ run }) => {
        it.each([undefined, false, true])("regenerates in the selected mode with lazyFunctions=%s", async (lazyFunctions) => {
            expect.assertions(5);

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
            expect(functions.includes("export const LUNORA_FUNCTION_MANIFEST")).toBe(lazyFunctions === true);
            expect(existsSync(join(generated, "fn", "lunora_messages_0.ts"))).toBe(lazyFunctions === true);
            expect(functions).toContain("messages:latest");
            expect(functions).not.toContain("messages:list");
        });
    });

    describe("verify lazy metadata gate", () => {
        it.each([undefined, false, true])("checks the selected registry mode with lazyFunctions=%s without writing", async (lazyFunctions) => {
            expect.assertions(3);

            writeFileSync(
                join(projectRoot, "lunora", "messages.ts"),
                'import { query } from "@lunora/server";\nconst base = query.expose({ rest: enabled });\nexport const list = base.query(() => []);\n',
            );
            const result = await runExecute<VerifyOptions, VerifyCommandData>(verify, {
                commandName: "verify",
                cwd: projectRoot,
                options: { format: "json", lazyFunctions, strictAdvisories: false, typecheck: false },
            });

            expect(result.code).toBe(lazyFunctions === true ? 1 : 0);
            expect(result.document?.data?.errors.join("\n").includes("lazy function registry needs literal")).toBe(lazyFunctions === true);
            expect(existsSync(join(projectRoot, "lunora", "_generated"))).toBe(false);
        });
    });
});
