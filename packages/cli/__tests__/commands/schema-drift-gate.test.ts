import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportEndLine } from "../../../../shared/export-end";
import { runBuildCommand } from "../../src/commands/build/handler";
import type { StreamingFetchLike } from "../../src/commands/data-transfer/shared";
import { runDeployCommand } from "../../src/commands/deploy/handler";
import { runPrepareCommand } from "../../src/commands/prepare/handler";
import { runVerifyCommand } from "../../src/commands/verify/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
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

/** A real backfill for {@link introduceBreakingDrift}. */
const CONVERTING_UP = "(doc) => ({ ...doc, name: Number(doc.name) })";

/** Write `lunora/migrations.ts` with one `defineMigration`, so a NEW migration id is discovered. */
const addMigration = (id: string, table = "users", up = CONVERTING_UP): void => {
    const migrationsPath = join(workdir, "lunora", "migrations.ts");

    writeFileSync(
        migrationsPath,
        `import { defineMigration } from "@lunora/server";\n\nexport const fix = defineMigration({\n    id: "${id}",\n    table: "${table}",\n    up: ${up},\n});\n`,
        "utf8",
    );
};

/** Drop the `by_channel` index — a breaking change that breaks call sites and touches no stored row. */
const dropIndex = (): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");

    writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace(`.index("by_channel", ["channelId"])\n`, ""), "utf8");
};

/** Drop the `places` table: a breaking change before, now a warning that its rows stay in place. */
const dropTable = (): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");
    const source = readFileSync(schemaPath, "utf8");
    const start = source.indexOf("    // Coverage table — exercises `v.geoPoint()`");
    const end = source.indexOf('}).geoIndex("by_location", { field: "location" }),', start) + '}).geoIndex("by_location", { field: "location" }),'.length;

    writeFileSync(schemaPath, `${source.slice(0, start)}${source.slice(end)}`, "utf8");
};

/** Remove or restore the `sessions` TTL so a later run gains one. */
const setSessionsTtl = (ttl: boolean): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");
    const source = readFileSync(schemaPath, "utf8");

    writeFileSync(
        schemaPath,
        ttl
            ? source.replace("}),\n\n    // Coverage table — exercises the drizzle", '}).ttl("expiresAt"),\n\n    // Coverage table — exercises the drizzle')
            : source.replace('.ttl("expiresAt")', ""),
        "utf8",
    );
};

/** `messages` stops being `.shardBy("channelId")`: its rows would have to move. */
const flipShardMode = (): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");

    writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace('        .shardBy("channelId")\n', ""), "utf8");
};

/** A function that queries `messages` through the `by_channel` index. */
const addIndexedQuery = (): void => {
    writeFileSync(
        join(workdir, "lunora", "finder.ts"),
        `import { query, v } from "@lunora/server";\n\nexport const byChannel = query({\n    args: { channelId: v.id("channels") },\n    handler: async (context, args) => context.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", args.channelId)).collect(),\n});\n`,
        "utf8",
    );
};

/** Add a unique index on `users.name`, a constraint the stored rows may already violate. */
const addUniqueIndex = (): void => {
    const schemaPath = join(workdir, "lunora", "schema.ts");

    writeFileSync(
        schemaPath,
        readFileSync(schemaPath, "utf8").replace(
            '.index("by_email", ["email"], { unique: true })',
            '.index("by_email", ["email"], { unique: true })\n        .index("by_name", ["name"], { unique: true })',
        ),
        "utf8",
    );
};

/** A deployed worker whose admin export holds `rows`, recording which tables were read. */
const deployedWorker = (rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>): { fetchImpl: StreamingFetchLike; reads: string[][] } => {
    const reads: string[][] = [];
    const fetchImpl: StreamingFetchLike = async (url, init) => {
        if (url !== "https://lunora-app.acme.workers.dev/_lunora/admin/export") {
            throw new Error(`unexpected request to ${url}`);
        }

        const { tables } = JSON.parse(String(init?.body)) as { tables: string[] };
        const served = rows.filter((row) => tables.includes(row.table));
        const text = `${served.map((row) => `${JSON.stringify(row)}\n`).join("")}${exportEndLine(served.length)}`;

        reads.push(tables);

        return {
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                },
            }),
            json: async () => undefined,
            ok: true,
            status: 200,
            text: async () => text,
        };
    };

    return { fetchImpl, reads };
};

const TARGET = { migrateToken: "admin-token", migrateUrl: "https://lunora-app.acme.workers.dev" };

describe("schema-drift gate", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-drift-gate-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        // A *.workers.dev target is only trusted for row reads when the project is linked to it.
        mkdirSync(join(workdir, ".lunora"), { recursive: true });
        writeFileSync(join(workdir, ".lunora", "project.json"), JSON.stringify({ workerUrl: TARGET.migrateUrl }), "utf8");
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

        it("lets a backward-compatible change through a --dry-run with no deployment URL or admin token, as a pull-request check runs it", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            const schemaPath = join(workdir, "lunora", "schema.ts");

            writeFileSync(
                schemaPath,
                readFileSync(schemaPath, "utf8").replace("name: v.string(),", "name: v.string(),\n        nickname: v.optional(v.string()),"),
                "utf8",
            );

            const result = await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(result.schemaDrift?.blocked).not.toBe(true);
            expect(result.code).toBe(0);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

        it("passes a blocked change, and re-blesses, when every stored row already fits the new schema", async () => {
            expect.assertions(4);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const worker = deployedWorker([
                { doc: { _id: "u1", name: 7 }, table: "users" },
                { doc: { _id: "m1", channelId: "c1", text: "untouched table" }, table: "messages" },
            ]);
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ ...TARGET, cwd: workdir, fetchImpl: worker.fetchImpl, logger: silentLogger().logger, spawner });

            expect(result.code).toBe(0);
            expect(calls.length).toBeGreaterThan(0);
            // Only the table the change touches is read.
            expect(worker.reads).toStrictEqual([["users"]]);

            const followUp = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(followUp.code).toBe(0);
        });

        it("refuses a new unique index over duplicate stored rows, naming the rows and keeping the baseline", async () => {
            expect.assertions(5);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            addUniqueIndex();

            const worker = deployedWorker([
                { doc: { _id: "u1", name: "Ada" }, table: "users" },
                { doc: { _id: "u2", name: "Grace" }, table: "users" },
                { doc: { _id: "u3", name: "Ada" }, table: "users" },
            ]);
            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ ...TARGET, cwd: workdir, fetchImpl: worker.fetchImpl, logger, spawner });
            const message = errors.join("\n");

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(calls).toHaveLength(0);
            expect(message).toContain("users u3: name duplicates u1");
            expect(message).not.toContain("Ada");
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
        });

        it("passes a new unique index when no stored row repeats a value, and the baseline advances", async () => {
            expect.assertions(5);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            addUniqueIndex();

            const worker = deployedWorker([
                { doc: { _id: "u1", name: "Ada" }, table: "users" },
                { doc: { _id: "u2", name: "Grace" }, table: "users" },
                { doc: { _id: "u3" }, table: "users" },
                { doc: { _id: "u4" }, table: "users" },
            ]);
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ ...TARGET, cwd: workdir, fetchImpl: worker.fetchImpl, logger: silentLogger().logger, spawner });

            expect(result.code).toBe(0);
            expect(calls.length).toBeGreaterThan(0);
            expect(worker.reads).toStrictEqual([["users"]]);
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).not.toBe(baselineBefore);

            // Nothing left to check: a deploy that could not read rows would be refused if the constraint were still drift.
            const followUp = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(followUp.code).toBe(0);
        });

        it("keeps the block on a new unique index when the stored rows cannot be read", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            addUniqueIndex();

            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain("The stored rows were not checked");
        });

        it("a dropped index does not block a deploy and the baseline advances with it", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            dropIndex();

            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner });

            expect(result.code).toBe(0);
            expect(calls.length).toBeGreaterThan(0);
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).not.toBe(baselineBefore);
        });

        it("a dropped table passes with a warning that its rows are left in place, and the baseline advances", async () => {
            expect.assertions(4);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            dropTable();

            const { logger, warns } = silentLogger();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(result.code).toBe(0);
            expect(warns.join("\n")).toContain("removed table places");
            expect(warns.join("\n")).toContain("left in place");
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).not.toBe(baselineBefore);
        });

        it("gaining a TTL passes, and the warning counts the stored rows the next sweep deletes", async () => {
            expect.assertions(3);

            setSessionsTtl(false);
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            setSessionsTtl(true);

            const worker = deployedWorker([
                { doc: { _id: "s1", expiresAt: 1, token: "a" }, table: "sessions" },
                { doc: { _id: "s2", expiresAt: 1, token: "b" }, table: "sessions" },
                { doc: { _id: "s3", expiresAt: Date.now() + 1e12, token: "c" }, table: "sessions" },
                { doc: { _id: "s4", token: "d" }, table: "sessions" },
            ]);
            const { logger, warns } = silentLogger();
            const result = await runDeployCommand({ ...TARGET, cwd: workdir, fetchImpl: worker.fetchImpl, logger, spawner: createRecordingSpawner().spawner });

            expect(result.code).toBe(0);
            expect(warns.join("\n")).toContain("gained a TTL policy");
            expect(warns.join("\n")).toContain("2 stored row(s) are past the new cutoff");
        });

        it("gaining a TTL still passes when the rows cannot be read, and says they were not counted", async () => {
            expect.assertions(2);

            setSessionsTtl(false);
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            setSessionsTtl(true);

            const { logger, warns } = silentLogger();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(result.code).toBe(0);
            expect(warns.join("\n")).toContain("could not be counted");
        });

        it("a shard-mode flip stays blocked and names the migration path, and a migration on that table clears it", async () => {
            expect.assertions(5);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            flipShardMode();

            const { errors, logger } = silentLogger();
            const blocked = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(blocked.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("lunora export --tables messages --out messages.ndjson");
            expect(errors.join("\n")).toContain('defineMigration({ id: "rehome_messages", table: "messages"');

            addMigration("rehome_messages", "messages", "(doc) => ({ ...doc, tenant: 'default' })");

            const { calls, spawner } = createRecordingSpawner();
            const cleared = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner });

            expect(cleared.code).toBe(0);
            expect(calls.length).toBeGreaterThan(0);
        });

        it("a dropped index a query still names is refused with the function named; an unused one passes", async () => {
            expect.assertions(3);

            addIndexedQuery();
            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            dropIndex();

            const { errors, logger } = silentLogger();
            const refused = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(refused.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("byChannel");

            rmSync(join(workdir, "lunora", "finder.ts"));

            const passed = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(passed.code).toBe(0);
        });

        it("names each stored row that does not fit — table, id, field, reason, never the value — and stays blocked", async () => {
            expect.assertions(4);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const worker = deployedWorker([
                { doc: { _id: "u1", name: 7 }, table: "users" },
                { doc: { _id: "u2", name: "Ada Lovelace" }, table: "users" },
            ]);
            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ ...TARGET, cwd: workdir, fetchImpl: worker.fetchImpl, logger, spawner });
            const message = errors.join("\n");

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(calls).toHaveLength(0);
            expect(message).toContain("users u2: name expected number, found string");
            expect(message).not.toContain("Ada Lovelace");
        });

        it("keeps the block when there is no deployed worker to read", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({ cwd: workdir, logger, spawner });

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain("The stored rows were not checked: no deployed worker to read the stored rows from");
        });

        it("--allow-schema-drift ships the run, checks nothing and leaves the baseline alone, even when the stored rows would confirm the shape", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            const worker = deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]);
            const overridden = await runDeployCommand({
                ...TARGET,
                allowSchemaDrift: true,
                cwd: workdir,
                fetchImpl: worker.fetchImpl,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner().spawner,
            });

            expect(overridden.code).toBe(0);
            expect(worker.reads).toStrictEqual([]);
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
        });

        it.each([
            ["a loopback dev worker", "http://127.0.0.1:8787", "it is a local or private address"],
            ["another environment's worker", "https://lunora-app-staging.acme.workers.dev", 'this deploy ships the Worker "lunora-app"'],
        ])("takes no stored-row evidence from %s, and stays blocked", async (_label, url, why) => {
            expect.assertions(3);

            rmSync(join(workdir, ".lunora"), { force: true, recursive: true });

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const { errors, logger } = silentLogger();
            const { calls, spawner } = createRecordingSpawner();
            const result = await runDeployCommand({
                cwd: workdir,
                fetchImpl: deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]).fetchImpl,
                logger,
                migrateToken: "admin-token",
                migrateUrl: url,
                spawner,
            });

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain(why);
        });

        it("takes no stored-row evidence from a URL other than the one this checkout is linked to for the --env", async () => {
            expect.assertions(2);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();
            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, ".lunora", "project.json"), JSON.stringify({ workerUrl: "https://app.acme.com" }), "utf8");

            const { errors, logger } = silentLogger();
            const result = await runDeployCommand({
                cwd: workdir,
                fetchImpl: deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]).fetchImpl,
                logger,
                migrateToken: "admin-token",
                migrateUrl: "https://lunora-app.acme.workers.dev",
                spawner: createRecordingSpawner().spawner,
            });

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("this checkout is linked to https://app.acme.com");
        });

        it("reads the stored rows from the link for this --env when no --migrate-url is given, and treats an empty one as unset", async () => {
            expect.assertions(3);

            rmSync(join(workdir, ".lunora"), { force: true, recursive: true });

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();

            const { errors, logger } = silentLogger();
            const unset = await runDeployCommand({
                cwd: workdir,
                logger,
                migrateToken: "admin-token",
                migrateUrl: "",
                spawner: createRecordingSpawner().spawner,
            });

            expect(unset.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("no deployed worker to read the stored rows from");

            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, ".lunora", "project.json"), JSON.stringify({ workerUrl: TARGET.migrateUrl }), "utf8");

            const linked = await runDeployCommand({
                cwd: workdir,
                fetchImpl: deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]).fetchImpl,
                logger: silentLogger().logger,
                migrateToken: "admin-token",
                spawner: createRecordingSpawner().spawner,
            });

            expect(linked.code).toBe(0);
        });

        it("does not let an identity migration (the scaffold's placeholder) cover a change on its own", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            introduceBreakingDrift();
            addMigration("backfill_users", "users", "(document) => document");

            const { errors, logger } = silentLogger();
            const blocked = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(blocked.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("backfill_users return each document unchanged");

            // The rows already fit, which is the only thing that can vouch for a migration that rewrites nothing.
            const fits = await runDeployCommand({
                ...TARGET,
                cwd: workdir,
                fetchImpl: deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]).fetchImpl,
                logger: silentLogger().logger,
                spawner: createRecordingSpawner().spawner,
            });

            expect(fits.code).toBe(0);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
            // The gate aborts before wrangler is spawned.
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("unreadable or malformed"))).toBe(true);
        });

        it("names how to recover: deleting the file makes the next deploy a first capture", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });
            writeFileSync(join(workdir, SNAPSHOT_FILE), "{ not valid json", "utf8");

            const { errors, logger } = silentLogger();
            const refused = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

            expect(errors.join("\n")).toContain("delete it");

            rmSync(join(workdir, SNAPSHOT_FILE), { force: true });

            const result = await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            expect(refused.code).toBe(EXIT_CODE.USAGE);
            expect(result.code).toBe(0);
        });
    });

    describe("lunora prepare / verify", () => {
        it("prepare blocks breaking drift without a migration", async () => {
            expect.assertions(2);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            introduceBreakingDrift();

            const result = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(result.schemaDrift?.blocked).toBe(true);
        });

        it("prepare --allow-schema-drift does not permanently disarm the gate", async () => {
            expect.assertions(4);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            const blocked = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(blocked.code).toBe(EXIT_CODE.USAGE);

            // The per-run override lets THIS run through — and prepare produces no
            // bundle, so nothing shipped.
            const overridden = await runPrepareCommand({ allowSchemaDrift: true, cwd: workdir, logger: silentLogger().logger });

            expect(overridden.code).toBe(0);
            // …and must not have advanced the committed baseline past a change no
            // deploy carried, which would defeat the gate for every later run.
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);

            const retry = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(retry.code).toBe(EXIT_CODE.USAGE);
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

            expect(blocked.code).toBe(EXIT_CODE.USAGE);
            expect(blockedText).toContain("build blocked");
            expect(blockedText).not.toContain("deploy blocked");
            expect(blockedText).not.toContain("--update-schema-baseline");

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

        it("prepare refuses a change only stored rows can confirm and points at deploy", async () => {
            expect.assertions(3);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });
            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();

            const { errors, logger } = silentLogger();
            const refused = await runPrepareCommand({ cwd: workdir, logger });

            expect(refused.code).toBe(EXIT_CODE.USAGE);
            expect(errors.join("\n")).toContain("`lunora prepare` does not read a deployment; run `lunora deploy`, which checks the stored rows first");
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
        });

        it("a dropped index does not block: prepare passes it and the baseline advances", async () => {
            expect.assertions(2);

            await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            dropIndex();

            const passed = await runPrepareCommand({ cwd: workdir, logger: silentLogger().logger });

            expect(passed.code).toBe(0);
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).not.toBe(baselineBefore);
        });

        it("never lets conforming rows clear a decision that also holds a change rows cannot decide", async () => {
            expect.assertions(3);

            await runDeployCommand({ cwd: workdir, logger: silentLogger().logger, spawner: createRecordingSpawner().spawner });

            const baselineBefore = readFileSync(join(workdir, SNAPSHOT_FILE), "utf8");

            introduceBreakingDrift();
            flipShardMode();

            const { errors, logger } = silentLogger();
            const result = await runDeployCommand({
                ...TARGET,
                cwd: workdir,
                fetchImpl: deployedWorker([{ doc: { _id: "u1", name: 7 }, table: "users" }]).fetchImpl,
                logger,
                spawner: createRecordingSpawner().spawner,
            });

            expect(result.schemaDrift?.blocked).toBe(true);
            expect(errors.join("\n")).toContain("changed shard mode");
            expect(readFileSync(join(workdir, SNAPSHOT_FILE), "utf8")).toBe(baselineBefore);
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
