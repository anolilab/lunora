import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy";
import type { FetchLike } from "../../src/commands/run";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

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
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

const silentLogger = (): { errors: string[]; infos: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const infos: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        infos,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => infos.push(message),
            success: () => {},
            warn: (message) => warns.push(message),
        },
        warns,
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

        it("auto-provisions missing bindings from inference, then blocks on D1 placeholder", async () => {
            expect.assertions(5);

            // A worker entry that exports ShardDO triggers binding inference.
            // The simple fixture has .global() tables so reconcile will write the
            // DB binding with the placeholder database_id — which must then BLOCK
            // the deploy with a clear error.
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
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            // Bindings were written into wrangler.jsonc by reconcile
            const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(written).toContain("ShardDO");
            expect(written).toContain('"DB"');

            // But deploy is blocked on the placeholder — wrangler is never spawned
            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("placeholder database_id") || line.includes("wrangler d1 create"))).toBe(true);
        });

        it("proceeds when D1 binding has a real database_id (not the placeholder)", async () => {
            expect.assertions(3);

            // Wrangler already has all bindings, including a real D1 database_id.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
            expect(result.error).toBeUndefined();
        });

        it("aborts when wrangler has a problem inference cannot fix", async () => {
            expect.assertions(3);

            // A stale compatibility_date is outside what reconcile touches, so
            // even after binding provisioning the validator must still abort.
            // We pre-write the SHARD binding and a real DB id so the D1
            // placeholder check is not triggered before the validator runs.
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "2020-01-01",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-id-xyz" }]
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

        it("blocks deploy when D1 binding has placeholder database_id", async () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "cirrus-app", "database_id": "<replace-with-d1-create-id>" }]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("placeholder database_id"))).toBe(true);
            expect(errors.some((line) => line.includes("wrangler d1 create"))).toBe(true);
        });

        it("does not run migrations when --migrate is not set", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            // Only one spawn call (wrangler deploy); no migration RPC calls
            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
        });

        it("skips migration phase when deploy fails (non-zero exit)", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            // A spawner that simulates a failed deploy
            const { spawner: failingSpawner } = createRecordingSpawner(1);
            const { logger, infos } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, migrate: true, spawner: failingSpawner });

            expect(result.code).toBe(1);
            // No migration info messages — migration phase was skipped
            expect(infos.some((line) => line.includes("--migrate"))).toBe(false);
        });

        it("--migrate: runs all declared migrations after a successful deploy", async () => {
            expect.assertions(4);

            // Write a migrations.ts so discoverMigrations finds at least one id
            const cirrusDirectory = join(workdir, "cirrus");
            const migrationsFile = join(cirrusDirectory, "migrations.ts");

            writeFileSync(
                migrationsFile,
                `import { defineMigration } from "@cirrus/server";

export const backfillNames = defineMigration({
    id: "backfill-names",
    table: "users",
    up: (doc) => doc,
});
`,
                "utf8",
            );

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();

            // Provide a fetch stub so runMigrateDataCommand succeeds without a
            // real worker. The RPC endpoint returns a 200 JSON body.
            const fetchStub: FetchLike = () =>
                Promise.resolve({
                    ok: true,
                    text: () => Promise.resolve(JSON.stringify({ status: "ok" })),
                } as Response);

            const { infos, logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                fetchImpl: fetchStub,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateUrl: "https://my-worker.workers.dev",
                spawner,
            });

            // Deploy succeeded
            expect(result.code).toBe(0);
            // wrangler deploy was spawned exactly once
            expect(calls).toHaveLength(1);
            // Migration log messages emitted
            expect(infos.some((line) => line.includes("--migrate"))).toBe(true);
            expect(infos.some((line) => line.includes("backfill-names"))).toBe(true);
        });
    });
});
