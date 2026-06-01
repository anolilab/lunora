import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "y" }]
}
`;

const silentLogger = (): { errors: string[]; logger: Logger } => {
    const errors: string[] = [];

    return {
        errors,
        logger: {
            error: (msg) => errors.push(msg),
            info: () => {},
            success: () => {},
            warn: () => {},
        },
    };
};

let workdir: string;

describe("cirrus deploy", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-deploy-"));
        cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus deploy", () => {
        test("runs codegen, validates wrangler, then spawns `pnpm exec wrangler deploy`", async () => {
            expect.assertions(5);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(result.validation.problems).toEqual([]);
            expect(calls).toHaveLength(1);

            const args = calls[0]?.descriptor.args.join(" ") ?? "";

            expect(args).toContain("wrangler");
            expect(args).toContain("deploy");
        });

        test("forwards --env to wrangler", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await runDeployCommand({ cwd: workdir, env: "production", logger, spawner });

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).toContain("--env");
            expect(args).toContain("production");
        });

        test("aborts when wrangler.jsonc is missing required bindings", async () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("SHARD"))).toBe(true);
        });
    });
});
