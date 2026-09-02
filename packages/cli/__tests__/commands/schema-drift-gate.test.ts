import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { runDeployCommand } from "../../src/commands/deploy/handler";
import { runPrepareCommand } from "../../src/commands/prepare/handler";
import { runVerifyCommand } from "../../src/commands/verify/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

// Each `lunora deploy` here runs a full codegen pass, and several tests chain
// three of them; under parallel CI load that exceeds the 30s default and times
// out mid-deploy, whose late-resolving promise then leaks an assertion into the
// next test (`expected 3, got 4`). Give the whole file generous headroom.
vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");
const SNAPSHOT_FILE = join("lunora", ".lunora-schema.json");

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

/** Overwrite `lunora/schema.ts` so `users.name` changes from `v.string()` to `v.number()` (breaking). */
const introduceBreakingDrift = (): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");
    const source = readFileSync(schemaPath, "utf8").replace("name: v.string(),", "name: v.number(),");

    writeFileSync(schemaPath, source, "utf8");
};

/** Append a `defineMigration` to `lunora/schema.ts` so a NEW migration id is discovered. */
const addMigration = (id: string, table = "users"): void => {
    const migrationsPath = join(workdir, "lunora", "migrations.ts");

    writeFileSync(
        migrationsPath,
        `import { defineMigration } from "@lunora/server";\n\nexport const fix = defineMigration({\n    id: "${id}",\n    table: "${table}",\n    up: (doc) => doc,\n});\n`,
        "utf8",
    );
};

describe("schema-drift gate", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-drift-gate-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora deploy", () => {
        it("blesses a baseline on first deploy and deploys cleanly (no drift)", async () => {
            expect.assertions(3);

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, SNAPSHOT_FILE))).toBe(true);
            expect(result.schemaDrift?.blocked).not.toBe(true);
        });

        it("blocks a deploy when a breaking change ships without a new migration", async () => {
            expect.assertions(4);

            // First deploy blesses the baseline.
            const first = createRecordingSpawner();
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: first.spawner });

            // Then introduce a breaking field-type change with no migration.
            introduceBreakingDrift();

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(result.schemaDrift?.blocked).toBe(true);
            // The gate aborts BEFORE wrangler is spawned.
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("deploy blocked"))).toBe(true);
        });

        it("block message names both remediation paths and links docs", async () => {
            expect.assertions(4);

            // Bless a baseline, then introduce a breaking change.
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const { errors, logger } = silentLogger();
            await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            // The error message must mention both remediation paths so the
            // developer knows what to do without consulting the docs.
            const blocked = errors.find((line) => line.includes("deploy blocked")) ?? "";

            expect(blocked).toContain("--allow-schema-drift");
            expect(blocked).toContain("defineMigration");
            expect(blocked).toContain("lunora migrate");
            expect(blocked).toContain("lunora.dev");
        });

        it("passes the same breaking change once a new migration id is added", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            introduceBreakingDrift();
            addMigration("fix-name-type");

            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner });

            expect(result.code).toBe(0);
            // Deploy proceeded — wrangler was spawned.
            expect(calls.length).toBeGreaterThan(0);
        });

        it("still blocks when the new migration iterates a DIFFERENT table", async () => {
            // Pins the wiring, not just the rule: `runCodegen` must hand its
            // discovered `migrations` to the gate. Drop that argument and the gate
            // falls back to counting ids, and this deploy would sail through.
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            introduceBreakingDrift();
            addMigration("backfill-messages", "messages");

            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).not.toBe(0);
            // wrangler was never reached.
            expect(calls).toHaveLength(0);
            expect(errors.find((line) => line.includes("deploy blocked")) ?? "").toContain("unresolved breaking schema change");
        });

        it("passes a blocked deploy when --allow-schema-drift is set", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            introduceBreakingDrift();

            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ allowSchemaDrift: true, cwd: workdir, logger: silentLogger().logger, spawner });

            expect(result.code).toBe(0);
            expect(calls.length).toBeGreaterThan(0);
        });

        it("re-blesses the baseline with --update-schema-baseline so the next deploy is clean", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            // Accept the new shape into the baseline.
            const blessed = await runDeployCommand({
                cwd: workdir,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner().spawner,
                updateSchemaBaseline: true,
            });

            expect(blessed.code).toBe(0);

            // A subsequent deploy with no further change sees no drift.
            const followUp = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(followUp.code).toBe(0);
        });

        it("does NOT advance the baseline when the deploy itself fails — the gate stays effective on retry", async () => {
            expect.assertions(3);

            // First deploy blesses the baseline at the original shape.
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            // Override the gate so it WOULD re-bless — but make `wrangler deploy` fail.
            const failed = await runDeployCommand({
                allowSchemaDrift: true,
                cwd: workdir,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner(1).spawner,
            });

            expect(failed.code).toBe(1);
            // The failed deploy must NOT have moved the committed baseline.
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);

            // A retry WITHOUT the override still sees the drift and blocks — proof
            // the baseline wasn't silently advanced past the unshipped change.
            const retry = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(retry.schemaDrift?.blocked).toBe(true);
        });
    });

    describe("corrupt baseline", () => {
        it("blocks deploy when the committed baseline is unreadable (does not silently treat it as a first capture)", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            writeFileSync(join(workdir, SNAPSHOT_FILE), "{ not valid json", "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            // The gate aborts before wrangler is spawned.
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("unreadable or malformed"))).toBe(true);
        });

        it("regenerates a corrupt baseline with --update-schema-baseline and deploys", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            writeFileSync(join(workdir, SNAPSHOT_FILE), "{ not valid json", "utf8");

            const result = await runDeployCommand({
                cwd: workdir,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner().spawner,
                updateSchemaBaseline: true,
            });

            expect(result.code).toBe(0);
            // The baseline is valid JSON again after a successful deploy re-blessed it.
            expect(() => JSON.parse(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8"))).not.toThrow();
        });
    });

    describe("lunora prepare / verify", () => {
        it("prepare blocks breaking drift without a migration", async () => {
            expect.assertions(2);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            introduceBreakingDrift();

            const result = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(result.code).toBe(1);
            expect(result.schemaDrift?.blocked).toBe(true);
        });

        it("prepare --allow-schema-drift does not permanently disarm the gate", async () => {
            expect.assertions(4);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            const blocked = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(blocked.code).toBe(1);

            // The per-run override lets THIS run through — and prepare produces no
            // bundle, so nothing shipped.
            const overridden = await runPrepareCommand({ allowSchemaDrift: true, cwd: workdir, logger: silentLogger().logger });

            expect(overridden.code).toBe(0);
            // …and must not have advanced the committed baseline past a change no
            // deploy carried, which would defeat the gate for every later run.
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);

            const retry = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(retry.code).toBe(1);
        });

        it("build accepts the --allow-schema-drift the blocked-drift message tells it to pass", async () => {
            expect.assertions(6);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            // Assert the MESSAGE, not just the exit code. The gate takes the
            // command name from the caller, and `build` delegates through
            // `runDeployCommand` — so a hardcoded "deploy" here told the operator
            // a deploy was blocked when none was attempted, and recommended
            // `--update-schema-baseline`, which `build` rejects with a raw
            // `Found unknown option` stack trace. Both halves of its own advice
            // failed, and an exit-code-only assertion could not see either.
            const blockedLog = silentLogger();
            const blocked = await runBuildCommand({ cwd: workdir, logger: blockedLog.logger, spawner: createRecordingSpawner().spawner });
            const blockedText = blockedLog.errors.join("\n");

            expect(blocked.code).toBe(1);
            expect(blockedText).toContain("build blocked");
            expect(blockedText).not.toContain("deploy blocked");
            expect(blockedText).not.toContain("pass `--update-schema-baseline`");

            const overridden = await runBuildCommand({
                allowSchemaDrift: true,
                cwd: workdir,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner().spawner,
            });

            expect(overridden.code).toBe(0);
            // A build publishes nothing, so the baseline stays where it was.
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
        });

        it("prepare --update-schema-baseline still accepts the new shape", async () => {
            expect.assertions(2);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            introduceBreakingDrift();

            const blessed = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger, updateSchemaBaseline: true });

            expect(blessed.code).toBe(0);

            const followUp = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(followUp.code).toBe(0);
        });

        it("verify surfaces breaking drift as an error without writing the baseline", async () => {
            expect.assertions(2);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            const result = await runVerifyCommand({ cwd: workdir, logger: silentLogger().logger, typecheck: false });

            expect(result.code).toBe(1);
            // verify is read-only — the committed baseline is untouched.
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
        });
    });
});
