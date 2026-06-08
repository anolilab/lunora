import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
            error: (message) => errors.push(message),
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
        it("runs codegen, validates wrangler, then spawns `pnpm exec wrangler deploy`", async () => {
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

        it("forwards --env to wrangler", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await runDeployCommand({ cwd: workdir, env: "production", logger, spawner });

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).toContain("--env");
            expect(args).toContain("production");
        });

        it("auto-provisions missing bindings from inference, then deploys", async () => {
            expect.assertions(4);

            // A worker entry that exports ShardDO is the safe signal for binding
            // the SHARD durable object. Inference + reconcile should add SHARD
            // (exported) and DB (the fixture schema is global) so validation
            // passes without the user hand-writing bindings.
            mkdirSync(join(workdir, "src", "server"), { recursive: true });
            writeFileSync(join(workdir, "src", "server", "index.ts"), "export const ShardDO = class {};\nexport default { fetch() {} };", "utf8");
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);

            const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(written).toContain("ShardDO");
            expect(written).toContain('"DB"');
        });

        it("aborts when wrangler has a problem inference cannot fix", async () => {
            expect.assertions(3);

            // A stale compatibility_date is outside what reconcile touches, so
            // even after binding provisioning the validator must still abort.
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2020-01-01"
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("compatibility_date"))).toBe(true);
        });
    });
});
