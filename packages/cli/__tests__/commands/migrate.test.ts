import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import {
    execute as migrateExecute,
    runMigrateCreateCommand,
    runMigrateDataCommand,
    runMigrateGenerateCommand,
    runMigrateToHyperdriveCommand,
} from "../../src/commands/migrate/handler";
import type { FetchLike } from "../../src/commands/run/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("lunora migrate", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-migrate-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeSchema = (source: string): void => {
        const lunora = join(workdir, "lunora");

        mkdirSync(lunora, { recursive: true });
        writeFileSync(join(lunora, "schema.ts"), source, "utf8");
    };

    const fixedNow = (): Date => new Date("2024-04-01T12:34:56.000Z");

    describe("lunora migrate generate", () => {
        it("errors when schema.ts is missing", () => {
            expect.assertions(3);

            const errors: string[] = [];
            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
            });

            expect(result.code).toBe(1);

            const message = errors.join("\n");

            expect(message).toContain("schema not found");
            expect(message).toContain("vis generate lunora-table --name=<name>");
        });

        it("first run on a global table emits CREATE TABLE", () => {
            expect.assertions(11);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }).global().index("by_email", ["email"], { unique: true }),
});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "init",
                now: fixedNow,
            });

            expect(result.code).toBe(0);
            expect(result.empty).toBe(false);
            expect(result.migrationFile).toMatch(/20240401123456_init\.sql$/u);

            const sql = readFileSync(result.migrationFile, "utf8");

            expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
            expect(sql).toContain('"id" TEXT PRIMARY KEY');
            expect(sql).toContain('"_creationTime" REAL NOT NULL');
            // The optimistic-concurrency row version the runtime auto-provisioner
            // also adds — emitted here so a hand-applied migration and the
            // auto-provisioner agree on the physical shape and the column budget.
            expect(sql).toContain('"_version" INTEGER');
            expect(sql).toContain('"email" TEXT NOT NULL');
            expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_by_email"');

            // Snapshot file is written next to the migration.
            const snapshotPath = join(workdir, "lunora", "migrations", ".snapshot.json");

            expect(existsSync(snapshotPath)).toBe(true);

            const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { tables: Record<string, unknown> };

            expect(Object.keys(snapshot.tables)).toEqual(["users"]);
        });

        it("ignores a hyperdrive-backed global table", () => {
            expect.assertions(3);

            // `.global({ backend: "hyperdrive" })` stores the table in a
            // Postgres/MySQL database reached through Hyperdrive, which
            // provisions itself from the schema at runtime. The generator renders
            // through `@lunora/d1/dialect` and has no dialect seam, so including
            // it wrote SQLite DDL — double-quoted identifiers, `REAL` affinity —
            // into a file the docs label "D1 SQL": a phantom table if it is ever
            // applied to D1, and invalid syntax on MySQL.
            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    accounts: defineTable({
        email: v.string(),
    }).global({ backend: "hyperdrive" }).index("by_email", ["email"]),
});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "init",
                now: fixedNow,
            });

            expect(result.code).toBe(0);
            expect(result.empty).toBe(true);
            expect(result.migrationFile).toBe("");
        });

        it("ignores sharded (non-global) tables", () => {
            expect.assertions(3);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }).shardBy("text"),
});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "init",
                now: fixedNow,
            });

            expect(result.code).toBe(0);
            expect(result.empty).toBe(true);
            expect(result.migrationFile).toBe("");
        });

        it("second run on identical schema is a no-op", () => {
            expect.assertions(4);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
            );

            const first = runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

            expect(first.code).toBe(0);
            expect(first.empty).toBe(false);

            const second = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "noop",
                now: () => new Date("2024-04-02T00:00:00.000Z"),
            });

            expect(second.code).toBe(0);
            expect(second.empty).toBe(true);
        });

        it("adding a column produces ALTER TABLE ADD COLUMN", () => {
            expect.assertions(4);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
            );

            runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
        nickname: v.optional(v.string()),
    }).global(),
});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "add_nickname",
                now: () => new Date("2024-04-02T00:00:00.000Z"),
            });

            expect(result.code).toBe(0);
            expect(result.empty).toBe(false);

            const sql = readFileSync(result.migrationFile, "utf8");

            expect(sql).toContain('ADD COLUMN "nickname" TEXT');
            expect(sql).not.toContain("NOT NULL"); // v.optional → nullable
        });

        it("detects a same-affinity type change (v.string() -> v.bigint(), both TEXT)", () => {
            expect.assertions(3);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
            );

            runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.bigint() }).global(),
});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "retype_email",
                now: () => new Date("2024-04-02T00:00:00.000Z"),
            });

            expect(result.code).toBe(0);
            // Both kinds map to the TEXT affinity, so the affinity alone says
            // nothing — the validator shape has to be compared.
            expect(result.empty).toBe(false);
            expect(readFileSync(result.migrationFile, "utf8")).toContain("users.email");
        });

        it("removed table produces DROP TABLE", () => {
            expect.assertions(2);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    sessions: defineTable({ token: v.string() }).global(),
});
`,
            );

            runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

            writeSchema(
                `import { defineSchema, defineTable } from "@lunora/server";

export const schema = defineSchema({});
`,
            );

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "drop_sessions",
                now: () => new Date("2024-04-02T00:00:00.000Z"),
            });

            expect(result.code).toBe(0);

            const sql = readFileSync(result.migrationFile, "utf8");

            expect(sql).toContain('DROP TABLE IF EXISTS "sessions"');
        });

        it("emits a manual-SQL comment block for unsupported diffs (drop column)", () => {
            expect.assertions(4);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
        legacy: v.optional(v.string()),
    }).global(),
});
`,
            );

            runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
            );

            const warnings: string[] = [];

            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), warn: (m) => warnings.push(m) },
                name: "drop_legacy",
                now: () => new Date("2024-04-02T00:00:00.000Z"),
            });

            expect(result.code).toBe(0);

            const sql = readFileSync(result.migrationFile, "utf8");

            expect(sql).toContain("NOT auto-generated");
            expect(sql).toContain("legacy");
            expect(warnings.join("\n")).toMatch(/unsupported diff/u);
        });
    });

    const writeMigrations = (source: string): void => {
        const lunora = join(workdir, "lunora");

        mkdirSync(lunora, { recursive: true });
        writeFileSync(join(lunora, "migrations.ts"), source, "utf8");
    };

    const migrationsFile = (): string => join(workdir, "lunora", "migrations.ts");

    describe("lunora migrate create", () => {
        it("scaffolds lunora/migrations.ts with a defineMigration block", async () => {
            expect.assertions(7);

            const result = await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "Backfill Read By", table: "messages" });

            expect(result.code).toBe(0);
            expect(result.file).toBe(migrationsFile());

            const content = readFileSync(result.file, "utf8");

            expect(content).toContain('import { defineMigration } from "@lunora/server";');
            expect(content).toContain("export const backfillReadBy = defineMigration({");
            expect(content).toContain('id: "backfill-read-by",');
            expect(content).toContain('table: "messages",');
            expect(content).toContain("up: (document) => document,");
        });

        it("emits the umbrella import when the project depends on lunorash", async () => {
            expect.assertions(2);

            // `@lunora/server` is real but is NOT a declared dependency of an
            // umbrella project, so the scoped form scaffolded a file that did not
            // resolve in exactly the setup the docs recommend.
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { lunorash: "1.0.0-alpha.130" }, name: "app" }), "utf8");

            const result = await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "backfill", table: "messages" });
            const content = readFileSync(result.file, "utf8");

            expect(content).toContain('import { defineMigration } from "lunorash/server";');
            expect(content).not.toContain('from "@lunora/server"');
        });

        it("rewrites an existing import written under the other specifier", async () => {
            expect.assertions(3);

            // A file scaffolded before the project adopted `lunorash` carries the
            // scoped import. Matching only the specifier we would emit prepended a
            // SECOND `defineMigration` import beside it, and a duplicate local
            // binding does not compile.
            await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "first", table: "messages" });

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { lunorash: "1.0.0-alpha.130" }, name: "app" }), "utf8");

            const result = await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "second", table: "messages" });
            const content = readFileSync(result.file, "utf8");

            expect(content.match(/import \{ defineMigration \}/gu)).toHaveLength(1);
            expect(content).toContain('from "lunorash/server"');
            expect(content).not.toContain('from "@lunora/server"');
        });

        it("appends a second migration without duplicating the import", async () => {
            expect.hasAssertions();

            await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "first", table: "a" });
            const result = await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "second", table: "b" });

            expect(result.code).toBe(0);

            const content = readFileSync(result.file, "utf8");

            expect(content.match(/import \{ defineMigration \}/gu)).toHaveLength(1);
            expect(content).toContain("export const first = defineMigration({");
            expect(content).toContain("export const second = defineMigration({");
        });

        it("refuses to clobber an existing migration of the same id", async () => {
            expect.assertions(2);

            await runMigrateCreateCommand({ cwd: workdir, logger: silentLogger(), name: "dupe", table: "a" });

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                name: "dupe",
                table: "a",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("already exists");
        });

        it("rejects a name with no alphanumeric characters", async () => {
            expect.assertions(2);

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({ cwd: workdir, logger: { ...silentLogger(), error: (m) => errors.push(m) }, name: "---" });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("invalid migration name");
        });

        it.each(["123 backfill", "999", "class", "default"])("rejects %s whose export identifier would be uncompilable", async (name) => {
            expect.assertions(2);

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                name,
                table: "messages",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("invalid migration name");
        });

        it("fails without --table when not running interactively", async () => {
            expect.assertions(3);

            // Force the non-interactive path even when the runner has a TTY.
            const originalIsTty = process.stdin.isTTY;

            Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

            const errors: string[] = [];

            try {
                const result = await runMigrateCreateCommand({
                    cwd: workdir,
                    logger: { ...silentLogger(), error: (m) => errors.push(m) },
                    name: "needs_table",
                });

                expect(result.code).toBe(1);
            } finally {
                Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
            }

            expect(errors.join("\n")).toContain("--table");
            expect(existsSync(migrationsFile())).toBe(false);
        });

        it("prompts for the table when --table is omitted, offering the schema's tables", async () => {
            expect.assertions(4);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({ text: v.string() }).shardBy("text"),
    users: defineTable({ email: v.string() }).global(),
});
`,
            );

            const seen: string[][] = [];
            const result = await runMigrateCreateCommand({
                cwd: workdir,
                logger: silentLogger(),
                name: "backfill",
                promptTable: async (tables) => {
                    seen.push([...tables]);

                    return "messages";
                },
            });

            expect(result.code).toBe(0);
            expect(seen).toHaveLength(1);
            expect(seen[0]).toEqual(["messages", "users"]);
            expect(readFileSync(result.file, "utf8")).toContain('table: "messages",');
        });

        it("errors when the table prompt is aborted", async () => {
            expect.assertions(3);

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                name: "aborted",
                promptTable: async () => undefined,
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("no table selected");
            expect(existsSync(migrationsFile())).toBe(false);
        });

        it("rejects a prompted table that is not a bare identifier", async () => {
            expect.assertions(2);

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                name: "injected",
                promptTable: async () => 'x", evil: "y',
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain("invalid table");
        });
    });

    const MIGRATIONS_SOURCE = `import { defineMigration } from "@lunora/server";

export const backfillReadBy = defineMigration({
    id: "backfill-read-by",
    table: "messages",
    up: (document) => document,
});
`;

    interface CapturedCall {
        body: { args: Record<string, unknown>; functionPath: string; table: string };
        headers?: Record<string, string>;
        url: string;
    }

    const captureFetch =
        (calls: CapturedCall[], response: { json: () => Promise<unknown>; ok: boolean; status: number }): FetchLike =>
        async (url, init) => {
            calls.push({ body: init?.body ? (JSON.parse(init.body) as CapturedCall["body"]) : ({} as CapturedCall["body"]), headers: init?.headers, url });

            return { json: response.json, ok: response.ok, status: response.status, text: async () => "" };
        };

    const okResponse = (body?: unknown): { json: () => Promise<unknown>; ok: boolean; status: number } => {
        const resolvedBody = body ?? { ok: 1 };

        return {
            json: async () => resolvedBody,
            ok: true,
            status: 200,
        };
    };

    describe("lunora migrate up/down/status", () => {
        beforeEach(() => {
            writeMigrations(MIGRATIONS_SOURCE);
        });

        it("up POSTs a runMigration admin RPC to /_lunora/migrate with the resolved table and bearer", async () => {
            expect.assertions(5);

            const calls: CapturedCall[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
                url: "http://localhost:9999",
            });

            expect(result.code).toBe(0);
            expect(result.requestUrl).toBe("http://localhost:9999/_lunora/migrate");
            expect(calls).toHaveLength(1);
            expect(calls[0]?.body).toEqual({
                args: { direction: "up", id: "backfill-read-by" },
                functionPath: "__lunora_admin__:runMigration",
                table: "messages",
            });
            expect(calls[0]?.headers?.authorization).toBe("Bearer s3cret");
        });

        it("forwards --dry-run, --batch-size and --steps into the runner args", async () => {
            expect.assertions(1);

            const calls: CapturedCall[] = [];

            await runMigrateDataCommand({
                batchSize: 250,
                cwd: workdir,
                dryRun: true,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: silentLogger(),
                maxBatches: 3,
                subcommand: "up",
                token: "s3cret",
            });

            expect(calls[0]?.body.args).toEqual({ batchSize: 250, direction: "up", dryRun: true, id: "backfill-read-by", maxBatches: 3 });
        });

        it("down sets direction to down", async () => {
            expect.assertions(1);

            const calls: CapturedCall[] = [];

            await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "down",
                token: "s3cret",
            });

            expect(calls[0]?.body.args.direction).toBe("down");
        });

        it("status sends migrationStatus with no direction", async () => {
            expect.assertions(2);

            const calls: CapturedCall[] = [];

            await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse({ changed: 0, failed: 0, ok: 1, processed: 0, shards: [], status: "in_progress" })),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "status",
                token: "s3cret",
            });

            expect(calls[0]?.body.functionPath).toBe("__lunora_admin__:migrationStatus");
            expect(calls[0]?.body.args).toEqual({ id: "backfill-read-by" });
        });

        it("falls back to LUNORA_ADMIN_TOKEN when --token is omitted", async () => {
            expect.hasAssertions();

            const calls: CapturedCall[] = [];
            const previous = process.env.LUNORA_ADMIN_TOKEN;

            process.env.LUNORA_ADMIN_TOKEN = "from-env";

            try {
                await runMigrateDataCommand({
                    cwd: workdir,
                    fetchImpl: captureFetch(calls, okResponse()),
                    id: "backfill-read-by",
                    logger: silentLogger(),
                    subcommand: "up",
                });
            } finally {
                if (previous === undefined) {
                    delete process.env.LUNORA_ADMIN_TOKEN;
                } else {
                    process.env.LUNORA_ADMIN_TOKEN = previous;
                }
            }

            expect(calls[0]?.headers?.authorization).toBe("Bearer from-env");
        });

        it("falls back to the .dev.vars token against a local worker", async () => {
            expect.hasAssertions();

            const calls: CapturedCall[] = [];
            const previous = process.env.LUNORA_ADMIN_TOKEN;

            delete process.env.LUNORA_ADMIN_TOKEN;
            writeFileSync(join(workdir, ".dev.vars"), "LUNORA_ADMIN_TOKEN=from-dev-vars\n", "utf8");

            try {
                await runMigrateDataCommand({
                    cwd: workdir,
                    fetchImpl: captureFetch(calls, okResponse()),
                    id: "backfill-read-by",
                    logger: silentLogger(),
                    subcommand: "up",
                });
            } finally {
                if (previous !== undefined) {
                    process.env.LUNORA_ADMIN_TOKEN = previous;
                }
            }

            expect(calls[0]?.headers?.authorization).toBe("Bearer from-dev-vars");
        });

        // The documented invocation is `lunora migrate up <id>` — the docs once
        // showed a bare `up`/`status`, which exits 1. Pin the requirement so the
        // examples cannot drift back.
        it.each(["up", "down", "status"])("requires a migration id for %s", async (subcommand) => {
            expect.assertions(1);

            let exitCode: number | undefined;

            await migrateExecute({
                argument: [subcommand],
                options: {},
                process: { cwd: workdir, exit: (code: number) => (exitCode = code) },
            } as unknown as Parameters<typeof migrateExecute>[0]);

            expect(exitCode).toBe(1);
        });

        it("errors when no admin token is available", async () => {
            expect.hasAssertions();

            const errors: string[] = [];
            const previous = process.env.LUNORA_ADMIN_TOKEN;

            delete process.env.LUNORA_ADMIN_TOKEN;

            try {
                const result = await runMigrateDataCommand({
                    cwd: workdir,
                    fetchImpl: captureFetch([], okResponse()),
                    id: "backfill-read-by",
                    logger: { ...silentLogger(), error: (m) => errors.push(m) },
                    subcommand: "up",
                });

                expect(result.code).toBe(1);
            } finally {
                if (previous !== undefined) {
                    process.env.LUNORA_ADMIN_TOKEN = previous;
                }
            }

            expect(errors.join("\n")).toContain("admin token required");
        });

        it("errors when the migration id is not declared under lunora/", async () => {
            expect.assertions(2);

            const errors: string[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch([], okResponse()),
                id: "ghost",
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(1);
            expect(errors.join("\n")).toContain('"ghost" not found');
        });

        it("--prod without --url is refused before any request", async () => {
            expect.assertions(3);

            const calls: CapturedCall[] = [];
            const errors: string[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                prod: true,
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain("--prod requires an explicit --url");
        });

        it("refuses up against a remote --url without --yes even when --prod is not passed", async () => {
            expect.assertions(3);

            const calls: CapturedCall[] = [];
            const errors: string[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
                subcommand: "up",
                token: "s3cret",
                url: "https://prod.example.invalid",
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join("\n")).toContain("--yes");
        });

        it("runs against a remote --url once --yes confirms it", async () => {
            expect.assertions(2);

            const calls: CapturedCall[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
                url: "https://prod.example.invalid",
                yes: true,
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
        });

        it("still runs against the implicit localhost target with no flags", async () => {
            expect.assertions(2);

            const calls: CapturedCall[] = [];

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(calls, okResponse()),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
        });

        it("returns non-zero on an HTTP error response", async () => {
            expect.assertions(1);

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch([], {
                    json: async () => {
                        return { error: { code: "ADMIN_FORBIDDEN" } };
                    },
                    ok: false,
                    status: 403,
                }),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(1);
        });
    });
});

/**
 * A fetch double that records every URL it is handed and answers with an empty
 * 200 — enough for the guard tests, which assert that NOTHING was requested.
 */
const recordingFetch =
    (calls: string[]): StreamingFetchLike =>
    async (input: string) => {
        calls.push(input);

        return {
            body: null,
            json: async () => {
                return {};
            },
            ok: true,
            status: 200,
            text: async () => "",
        };
    };

describe("lunora migrate d1-to-hyperdrive", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-cli-d1ps-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("streams .global() rows from the D1 source and imports them into the Hyperdrive target with matching counts", async () => {
        expect.assertions(4);

        const ndjson =
            '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n{"table":"settings","doc":{"_creationTime":2,"_id":"b","key":"y"}}\n';
        const calls: string[] = [];
        const infos: string[] = [];
        const logger: Logger = { error: () => {}, info: (message: string) => infos.push(message), success: () => {}, warn: () => {} };

        const fetchImpl: StreamingFetchLike = async (input: string) => {
            calls.push(input);

            if (input.includes("/_lunora/admin/export")) {
                return {
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(ndjson));
                            controller.close();
                        },
                    }),
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => ndjson,
                };
            }

            return {
                body: null,
                json: async () => {
                    return { inserted: { settings: 2 } };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runMigrateToHyperdriveCommand({
            fetchImpl,
            fromToken: "source-token",
            fromUrl: "https://old.example.com",
            logger,
            out: join(dir, "dump.ndjson"),
            tables: "settings",
            toToken: "target-token",
            toUrl: "https://new.example.com",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(calls.some((url) => new URL(url).origin === "https://old.example.com" && new URL(url).pathname.includes("/_lunora/admin/export"))).toBe(true);
        expect(calls.some((url) => new URL(url).origin === "https://new.example.com" && new URL(url).pathname.includes("/_lunora/admin/import"))).toBe(true);
        expect(infos.some((line) => line.includes("counts match"))).toBe(true);
    });

    it("refuses the import leg against a remote target when --yes was not passed", async () => {
        expect.assertions(2);

        const ndjson = '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n';
        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };
        const fetchImpl: StreamingFetchLike = async () => {
            return {
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(ndjson));
                        controller.close();
                    },
                }),
                json: async () => {
                    return {};
                },
                ok: true,
                status: 200,
                text: async () => ndjson,
            };
        };

        const result = await runMigrateToHyperdriveCommand({
            fetchImpl,
            fromToken: "source-token",
            fromUrl: "https://old.example.com",
            logger,
            out: join(dir, "dump.ndjson"),
            tables: "settings",
            toToken: "target-token",
            toUrl: "https://new.example.com",
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("--yes");
    });

    it("refuses a self-migration when neither --from-url nor --to-url is given", async () => {
        expect.assertions(3);

        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };
        const calls: string[] = [];
        const fetchImpl = recordingFetch(calls);

        const result = await runMigrateToHyperdriveCommand({ fetchImpl, logger, out: join(dir, "dump.ndjson"), yes: true });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.join("\n")).toContain("same deployment");
    });

    it("refuses a self-migration that differs only by a trailing slash", async () => {
        expect.assertions(3);

        // `resolveAdminBaseUrl` strips the trailing slash, so both legs address
        // the same worker — the guard compared the raw flags and let it through,
        // then reported "counts match" over a one-database no-op.
        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };
        const calls: string[] = [];
        const fetchImpl = recordingFetch(calls);

        const result = await runMigrateToHyperdriveCommand({
            fetchImpl,
            fromUrl: "https://worker.example.com/",
            logger,
            out: join(dir, "dump.ndjson"),
            toUrl: "https://worker.example.com",
            yes: true,
        });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.join("\n")).toContain("same deployment");
    });

    it("shreds the private plaintext dump dir even when the import throws", async () => {
        expect.hasAssertions();

        const ndjson = '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n';
        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };

        // Export streams rows, but the import batch POST returns a hard failure,
        // which makes runImportCommand throw — the temp dir must still be removed.
        const fetchImpl: StreamingFetchLike = async (input: string) => {
            if (input.includes("/_lunora/admin/export")) {
                return {
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(ndjson));
                            controller.close();
                        },
                    }),
                    json: async () => {
                        return {};
                    },
                    ok: true,
                    status: 200,
                    text: async () => ndjson,
                };
            }

            return {
                body: null,
                json: async () => {
                    return {};
                },
                ok: false,
                status: 500,
                text: async () => "boom",
            };
        };

        const dumpDirsBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("lunora-d1ps-"));

        // No `out` — the command stages the dump in a private mkdtemp dir it owns.
        // The failing batch surfaces as a non-zero code with the reason logged,
        // rather than as a throw: a bulk import that dies part-way has usually
        // already written rows, and the operator needs that tally.
        const failed = await runMigrateToHyperdriveCommand({
            fetchImpl,
            fromToken: "source-token",
            fromUrl: "https://old.example.com",
            logger,
            tables: "settings",
            toToken: "target-token",
            toUrl: "https://new.example.com",
            yes: true,
        });

        expect(failed.code).toBe(1);
        expect(errors.join("\n")).toContain("import batch failed");

        const dumpDirsAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("lunora-d1ps-"));

        // The finally block removed the staging dir it created; no new one leaked.
        expect(dumpDirsAfter).toStrictEqual(dumpDirsBefore);
    });
});
