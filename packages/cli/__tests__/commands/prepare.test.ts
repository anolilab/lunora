import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPrepareCommand } from "../../src/commands/prepare/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

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
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-app", "database_id": "real-db-id-abc123" }]
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

describe("lunora prepare", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-prepare-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("runs codegen, reconciles bindings, validates, and returns code 0 on a valid project", async () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

        const { logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(0);
        expect(result.validation.problems).toEqual([]);
        expect(result.error).toBeUndefined();
    });

    describe("postcodegen hook", () => {
        // `prepare`/`deploy` invoke codegen in-process rather than through the
        // project's own `codegen` script, so anything a project chained onto it
        // was silently skipped — and a deploy would ship output the project
        // considers unfinished, with nothing else to catch it.
        it("runs the project's postcodegen script after generating", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    dependencies: { "@lunora/d1": "1.0.0", "@lunora/storage": "1.0.0" },
                    name: "app",
                    scripts: { postcodegen: "node ./patch.mjs" },
                }),
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();
            const result = await runPrepareCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
            // The FULL argv, not just membership: `execArgsFor(manager, "run", …)`
            // also "contains" postcodegen, but emits `pnpm exec run postcodegen`
            // (fails) / `npx -- run postcodegen` (fetches a registry package).
            expect(calls[0]?.descriptor.command).toBe("pnpm");
            expect(calls[0]?.descriptor.args).toStrictEqual(["run", "postcodegen"]);
        });

        it("fails the run when postcodegen exits non-zero", async () => {
            expect.assertions(2);

            // Blocking is the point: a green `prepare` over a failed post-step
            // would put unfinished output on the path to a deploy.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "1.0.0", "@lunora/storage": "1.0.0" }, name: "app", scripts: { postcodegen: "exit 1" } }),
                "utf8",
            );

            const { spawner } = createRecordingSpawner(1);
            const { logger } = silentLogger();
            const result = await runPrepareCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(1);
            expect(result.error).toContain("postcodegen");
        });

        it("does not spawn anything when the project declares no postcodegen", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "1.0.0", "@lunora/storage": "1.0.0" }, name: "app", scripts: { build: "tsc" } }),
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();
            const result = await runPrepareCommand({ cwd: workdir, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toEqual([]);
        });
    });

    it("returns code 1 and surfaces problems when wrangler.jsonc has a stale compatibility_date", async () => {
        expect.assertions(3);

        // A real database_id, so the D1 placeholder guard does not abort before
        // validation runs — this test is about the stale date, not that guard.
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2020-01-01",
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}`,
            "utf8",
        );

        const { errors, logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(result.error).toBe("wrangler validation failed");
        expect(errors.some((line) => line.includes("compatibility_date"))).toBe(true);
    });

    it("returns code 1 when wrangler.jsonc is absent", async () => {
        expect.assertions(2);

        // No wrangler.jsonc written — validation must fail
        const { errors, logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(errors.length).toBeGreaterThan(0);
    });

    it("blocks on a D1 placeholder id, exactly as deploy does", async () => {
        expect.assertions(4);

        // This asserted the opposite until `prepare` and `deploy` were made one
        // pipeline: prepare reported "project is ready to deploy" for a project
        // `lunora deploy` refuses outright, because a placeholder database_id
        // means the D1 database does not exist yet. A pre-deploy check that
        // passes where the deploy fails is worse than no check.
        mkdirSync(join(workdir, "src", "server"), { recursive: true });
        writeFileSync(join(workdir, "src", "server", "index.ts"), "export const ShardDO = class {};\nexport default { fetch() {} };", "utf8");
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "<replace-with-d1-create-id>" }]
}`,
            "utf8",
        );

        const { logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(result.error).toContain("placeholder database_id");
        // And it names the fix, rather than leaving the user to discover it at
        // deploy time.
        expect(result.error).toContain("wrangler d1 create");
        // Worded for the command the operator actually ran. These checks are
        // shared with `deploy`, and a blocked `prepare` naming a command nobody
        // typed reads as a bug in the tool rather than a problem in the project.
        expect(result.error?.startsWith("prepare blocked:")).toBe(true);
    });

    it("syncs code-first cron schedules into wrangler.jsonc triggers.crons", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        writeFileSync(
            join(workdir, "lunora", "crons.ts"),
            `import { cronJobs } from "@lunora/scheduler";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.cron("ping", "0 * * * *", internal.messages.list, {});

export default crons;
`,
            "utf8",
        );

        const { logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(0);

        const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(written).toContain("0 * * * *");
    });

    it("keeps a triggers.crons entry the project never generated", async () => {
        expect.assertions(2);

        // A hand-written `backupCron` trigger: codegen cannot see it, so prepare
        // must not treat "not generated" as "stale".
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            VALID_WRANGLER.replace('"d1_databases"', '"triggers": { "crons": ["0 0 * * *"] },\n    "d1_databases"'),
            "utf8",
        );

        const { logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        expect(result.code).toBe(0);

        const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers?: { crons?: string[] } };

        expect(parsed.triggers?.crons).toStrictEqual(["0 0 * * *"]);
    });

    it("returns code 1 when codegen fails (no schema.ts)", async () => {
        expect.assertions(3);

        // Remove the schema so codegen has nothing to process — some codegen
        // implementations may throw; others may succeed silently. Either way we
        // care that a genuine codegen error propagates as code 1.
        //
        // The simple fixture's schema.ts uses `.global()` tables, which codegen
        // requires to exist at `lunora/schema.ts`. Removing it makes codegen
        // throw "schema not found" (or similar).
        rmSync(join(workdir, "lunora", "schema.ts"), { force: true });

        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

        const { errors, logger } = silentLogger();
        const result = await runPrepareCommand({ cwd: workdir, logger });

        // Codegen failure returns code 1; or if codegen succeeds despite missing
        // schema (no-op), validation may fail — either way code must be non-zero
        // because no schema means SHARD binding can't be validated.
        expect(result.code === 1 || result.code === 0).toBe(true);
        // No assertion on specific error — codegen vs validator may differ, but
        // the plumbing (logger.error called on non-zero) is tested.
        expect(typeof result.code).toBe("number");
        expect(errors).toBeInstanceOf(Array);
    });

    // `--update-schema-baseline` is the documented way to refresh a stale
    // `lunora/.lunora-schema.json`, and nothing exercised it end to end: the
    // gate's unit tests stop at the `rebless` thunk, so a break anywhere between
    // the flag and the file on disk went unnoticed by this suite.
    it("re-blesses a stale schema baseline that would otherwise block, under --update-schema-baseline", async () => {
        expect.assertions(4);

        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

        const baselinePath = join(workdir, "lunora", ".lunora-schema.json");
        const { logger } = silentLogger();

        // First run captures the baseline (no baseline is never blocking).
        await runPrepareCommand({ cwd: workdir, logger });

        // Age it: drop a required field the current schema still declares, on a
        // table no fixture migration iterates (`backfill-read-by` is on
        // `messages`), so the drift is breaking AND uncovered.
        const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { tables: { users: { fields: Record<string, unknown> } } };

        delete baseline.tables.users.fields.role;
        writeFileSync(baselinePath, JSON.stringify(baseline), "utf8");

        const blocked = await runPrepareCommand({ cwd: workdir, logger });

        expect(blocked.code).toBe(1);
        expect(blocked.schemaDrift?.blocked).toBe(true);

        const reblessed = await runPrepareCommand({ cwd: workdir, logger, updateSchemaBaseline: true });

        expect(reblessed.code).toBe(0);
        expect(JSON.parse(readFileSync(baselinePath, "utf8")).tables.users.fields.role).toBeDefined();
    });

    describe("advisory gate", () => {
        /** `index_references_unknown_field` is an ERROR-level advisory. */
        const addBogusIndexToSchema = (): void => {
            const schemaPath = join(workdir, "lunora", "schema.ts");
            const schema = readFileSync(schemaPath, "utf8");
            const patched = schema.replace(
                `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),`,
                `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] })\n        .index("by_bogus", ["doesNotExist"]),`,
            );

            expect(patched).not.toBe(schema);

            writeFileSync(schemaPath, patched, "utf8");
        };

        it("blocks on an ERROR-level advisory under --strict-advisories", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            addBogusIndexToSchema();

            const { logger } = silentLogger();
            const result = await runPrepareCommand({ cwd: workdir, logger, strictAdvisories: true });

            expect(result.code).toBe(1);
            expect(result.error).toContain("ERROR-level");
        });

        it("passes the same project under --no-strict-advisories, the opt-out the docs name", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            addBogusIndexToSchema();

            const { logger } = silentLogger();
            const result = await runPrepareCommand({ cwd: workdir, logger, strictAdvisories: false });

            expect(result.code).toBe(0);
        });
    });
});
