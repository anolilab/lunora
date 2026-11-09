import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportEndLine } from "../../../../shared/export-end";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { execute as migrateExecute } from "../../src/commands/migrate/dispatch";
import { runMigrateBackendCommand, runMigrateCreateCommand, runMigrateDataCommand, runMigrateGenerateCommand } from "../../src/commands/migrate/handler";
import { runMigrateSqlCommand } from "../../src/commands/migrate/sql";
import type { FetchLike } from "../../src/commands/run/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

/** Run `body` with `process.stdout.write` captured, and return what it wrote. */
const captureStdout = async (body: () => Promise<void>): Promise<string> => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));

        return true;
    });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return chunks.join("");
};

/** The answer to the `dryRun` POST that precedes an import: a worker that honours the flag writes nothing and echoes it. */
const checkResponse = (): Awaited<ReturnType<StreamingFetchLike>> => {
    return {
        body: null,
        json: async () => {
            return { conflicts: 0, dryRun: true, errors: [], inserted: {} };
        },
        ok: true,
        status: 200,
        text: async () => "",
    };
};

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

    /**
     * `--format json` across the subcommand dispatch.
     *
     * This is the branch's largest single refactor — the if-chain became a
     * `switch` over four `dispatch*` shells, each owning its own document — and
     * it landed with no `--format` coverage at all. Two independent signals said
     * so: the code-quality review, and Codecov reporting 54% patch coverage on
     * this file. The documents are a contract an agent parses, so they are
     * pinned here rather than left to the first caller to discover.
     */
    describe("--format json", () => {
        it("generate emits its document on stdout and keeps prose off it", async () => {
            expect.assertions(4);

            writeSchema(
                `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }).global(),
});
`,
            );

            const stdout = await captureStdout(async () => {
                await migrateExecute({
                    argument: ["generate", "init"],
                    options: { format: "json" },
                    process: { cwd: workdir, exit: () => {} },
                } as unknown as Parameters<typeof migrateExecute>[0]);
            });

            const document = JSON.parse(stdout) as { data: { empty: boolean; migrationFile?: string; subcommand: string } };

            expect(document.data.subcommand).toBe("generate");
            expect(document.data.empty).toBe(false);
            expect(document.data.migrationFile).toMatch(/init/u);
            // Exactly one document — stdout stays pipeable, the human lines go to stderr.
            expect(
                stdout
                    .trimEnd()
                    .split("\n")
                    .filter((line) => line === "}"),
            ).toHaveLength(1);
        });

        it("create carries the name and the scaffolded file", async () => {
            expect.assertions(2);

            const stdout = await captureStdout(async () => {
                await migrateExecute({
                    argument: ["create", "backfill_emails"],
                    options: { format: "json" },
                    process: { cwd: workdir, exit: () => {} },
                } as unknown as Parameters<typeof migrateExecute>[0]);
            });

            const document = JSON.parse(stdout) as { data: { file?: string; name: string; subcommand: string } };

            expect(document.data.subcommand).toBe("create");
            expect(document.data.name).toBe("backfill_emails");
        });

        it("refuses an unknown --format with the usage exit code, before dispatching", async () => {
            expect.assertions(2);

            let exitCode: number | undefined;
            const stdout = await captureStdout(async () => {
                await migrateExecute({
                    argument: ["generate"],
                    options: { format: "yaml" },
                    process: {
                        cwd: workdir,
                        exit: (code: number) => {
                            exitCode = code;
                        },
                    },
                } as unknown as Parameters<typeof migrateExecute>[0]);
            });

            expect(exitCode).toBe(EXIT_CODE.USAGE);
            // Refused before anything ran, so no document was written.
            expect(stdout).toBe("");
        });

        it("exits USAGE on an unknown subcommand", async () => {
            expect.assertions(1);

            let exitCode: number | undefined;

            await migrateExecute({
                argument: ["nope"],
                options: {},
                process: {
                    cwd: workdir,
                    exit: (code: number) => {
                        exitCode = code;
                    },
                },
            } as unknown as Parameters<typeof migrateExecute>[0]);

            expect(exitCode).toBe(EXIT_CODE.USAGE);
        });
    });

    describe("lunora migrate generate", () => {
        it("errors when schema.ts is missing", () => {
            expect.assertions(3);

            const errors: string[] = [];
            const result = runMigrateGenerateCommand({
                cwd: workdir,
                logger: { ...silentLogger(), error: (m) => errors.push(m) },
            });

            expect(result.code).toBe(EXIT_CODE.NOT_FOUND);

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

            expect(result.code).toBe(EXIT_CODE.CONFLICT);
            expect(errors.join("\n")).toContain("already exists");
        });

        it("rejects a name with no alphanumeric characters", async () => {
            expect.assertions(2);

            const errors: string[] = [];
            const result = await runMigrateCreateCommand({ cwd: workdir, logger: { ...silentLogger(), error: (m) => errors.push(m) }, name: "---" });

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

                expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            // Serialised from the SAME body the double declares: `runMigrateDataCommand`
            // reads the response through `readAndLogBody`, which calls `text()`, so a
            // double answering only `json()` made every assertion run against an empty
            // body — which is how the roll-up exit code went untested.
            return { json: response.json, ok: response.ok, status: response.status, text: async () => JSON.stringify(await response.json()) };
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
            // eslint-disable-next-line no-secrets/no-secrets -- a throwaway .dev.vars fixture in a temp directory, not a credential
            writeFileSync(join(workdir, ".dev.vars"), 'LUNORA_ADMIN_TOKEN="local"\n', "utf8");

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

            expect(calls[0]?.headers?.authorization).toBe("Bearer local");
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
                process: {
                    cwd: workdir,
                    exit: (code: number) => {
                        exitCode = code;
                    },
                },
            } as unknown as Parameters<typeof migrateExecute>[0]);

            expect(exitCode).toBe(EXIT_CODE.USAGE);
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

                expect(result.code).toBe(EXIT_CODE.AUTH);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

            expect(result.code).toBe(EXIT_CODE.USAGE);
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

        it("exits non-zero when the roll-up body reports every shard failed under a 200", async () => {
            expect.assertions(1);

            // `/_lunora/migrate` answers 200 unconditionally and folds the per-shard
            // outcomes into the BODY, so `Response.ok` is `true` for a migration that
            // ran nowhere — the same 207-shaped trap `import` documents.
            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(
                    [],
                    okResponse({
                        changed: 0,
                        failed: 3,
                        ok: 0,
                        processed: 0,
                        shards: [
                            { error: { message: "boom", timedOut: false }, shardKey: "a" },
                            { error: { message: "boom", timedOut: false }, shardKey: "b" },
                            { error: { message: "boom", timedOut: true }, shardKey: "c" },
                        ],
                        status: "failed",
                    }),
                ),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(1);
        });

        it("exits non-zero when a reached shard reports the migration itself failed", async () => {
            expect.assertions(1);

            const result = await runMigrateDataCommand({
                cwd: workdir,
                fetchImpl: captureFetch(
                    [],
                    okResponse({ changed: 0, failed: 0, ok: 1, processed: 10, shards: [{ result: { status: "failed" }, shardKey: "a" }], status: "failed" }),
                ),
                id: "backfill-read-by",
                logger: silentLogger(),
                subcommand: "up",
                token: "s3cret",
            });

            expect(result.code).toBe(1);
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

            expect(result.code).toBe(EXIT_CODE.PERMISSION);
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

describe("lunora migrate d1-to-hyperdrive | hyperdrive-to-d1", () => {
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
            '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n{"table":"settings","doc":{"_creationTime":2,"_id":"b","key":"y"}}\n{"end":true,"rows":2}\n';
        const calls: string[] = [];
        const infos: string[] = [];
        const logger: Logger = { error: () => {}, info: (message: string) => infos.push(message), success: () => {}, warn: () => {} };

        const fetchImpl: StreamingFetchLike = async (input: string) => {
            calls.push(input);

            // The check before the import writes nothing and reports no rows inserted.
            if (new URL(input).searchParams.get("dryRun") === "true") {
                return checkResponse();
            }

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

        const result = await runMigrateBackendCommand({
            direction: "d1-to-hyperdrive",
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

    it("rolls back the other way, naming Hyperdrive as the source and D1 as the target", async () => {
        expect.assertions(3);

        const ndjson = '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n{"end":true,"rows":1}\n';
        const infos: string[] = [];
        const logger: Logger = { error: () => {}, info: (message: string) => infos.push(message), success: () => {}, warn: () => {} };
        const fetchImpl: StreamingFetchLike = async (input: string) => {
            if (new URL(input).searchParams.get("dryRun") === "true") {
                return checkResponse();
            }

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
                    return { inserted: { settings: 1 } };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runMigrateBackendCommand({
            direction: "hyperdrive-to-d1",
            fetchImpl,
            fromToken: "source-token",
            fromUrl: "https://new.example.com",
            logger,
            out: join(dir, "dump.ndjson"),
            toToken: "target-token",
            toUrl: "https://old.example.com",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(infos.some((line) => line.includes("from the Hyperdrive source (https://new.example.com)"))).toBe(true);
        expect(infos.some((line) => line.includes("Verify your app reads from D1, then decommission the Hyperdrive binding"))).toBe(true);
    });

    describe("rolling back rows edited since cutover", () => {
        /**
         * Two deployments over in-memory tables: the source exports its rows, the target's
         * import endpoint behaves as the runtime does — insert-only by default, overwriting an
         * existing `_id` only under `?onConflict=replace`, which it echoes.
         */
        const deployments =
            (source: Map<string, string>, target: Map<string, string>, checks: string[] = []): StreamingFetchLike =>
            async (input: string, init?: { body?: unknown }) => {
                const url = new URL(input);

                if (url.searchParams.get("dryRun") === "true" && typeof init?.body === "string" && init.body.trim() !== "") {
                    checks.push(input);
                }

                if (url.pathname.includes("/_lunora/admin/export")) {
                    const ndjson = [...source].map(([id, key]) => JSON.stringify({ doc: { _creationTime: 1, _id: id, key }, table: "settings" })).join("\n");

                    return {
                        body: new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode(`${ndjson}\n${exportEndLine(source.size)}`));
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

                const replace = url.searchParams.get("onConflict") === "replace";
                const echo = replace ? { onConflict: "replace" } : {};

                if (url.searchParams.get("dryRun") === "true") {
                    return {
                        ...checkResponse(),
                        json: async () => {
                            return { conflicts: 0, dryRun: true, errors: [], inserted: {}, ...echo };
                        },
                    };
                }

                const rows = (typeof init?.body === "string" ? init.body : "")
                    .split("\n")
                    .filter((line) => line.trim() !== "")
                    .map((line) => JSON.parse(line) as { doc: { _id: string; key: string } });
                let conflicts = 0;
                let inserted = 0;
                let replaced = 0;

                for (const { doc } of rows) {
                    if (!target.has(doc._id)) {
                        inserted += 1;
                    } else if (replace) {
                        replaced += 1;
                    } else {
                        conflicts += 1;
                        continue;
                    }

                    target.set(doc._id, doc.key);
                }

                return {
                    body: null,
                    json: async () => {
                        return {
                            conflicts,
                            errors: [],
                            inserted: inserted > 0 ? { settings: inserted } : {},
                            received: rows.length,
                            replaced,
                            ...echo,
                        };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            };

        const rollBack = async (
            target: Map<string, string>,
            replace: boolean,
        ): Promise<{ checks: string[]; result: Awaited<ReturnType<typeof runMigrateBackendCommand>>; warnings: string[] }> => {
            const checks: string[] = [];
            const warnings: string[] = [];
            const logger: Logger = { error: () => {}, info: () => {}, success: () => {}, warn: (message: string) => warnings.push(message) };
            // Copied to Hyperdrive at cutover as "old", then edited there.
            const hyperdrive = new Map([["a", "edited on hyperdrive"]]);
            const result = await runMigrateBackendCommand({
                direction: "hyperdrive-to-d1",
                fetchImpl: deployments(hyperdrive, target, checks),
                fromToken: "source-token",
                fromUrl: "https://new.example.com",
                logger,
                out: join(dir, "dump.ndjson"),
                replace,
                tables: "settings",
                toToken: "target-token",
                toUrl: "https://old.example.com",
                yes: true,
            });

            return { checks, result, warnings };
        };

        it("leaves a row D1 already holds unchanged without --replace, and says so", async () => {
            expect.assertions(3);

            const d1 = new Map([["a", "old"]]);
            const { result, warnings } = await rollBack(d1, false);

            expect(d1.get("a")).toBe("old");
            expect(result).toMatchObject({ code: 0, imported: 0, replaced: 0 });
            expect(warnings.join("\n")).toContain("left unchanged (reported as conflicts above), so this copied rows missing from D1, not later edits");
        });

        it("restores the edited value with --replace", async () => {
            expect.assertions(3);

            const d1 = new Map([["a", "old"]]);
            const { checks, result } = await rollBack(d1, true);

            expect(d1.get("a")).toBe("edited on hyperdrive");
            expect(result).toMatchObject({ code: 0, imported: 0, replaced: 1 });
            // The pre-write check runs in the same mode, so a target that cannot replace refuses before anything is written.
            expect(checks.map((url) => new URL(url).searchParams.get("onConflict"))).toStrictEqual(["replace"]);
        });

        it("refuses --replace without --tables, before exporting anything", async () => {
            expect.assertions(2);

            const fetchImpl = vi.fn<StreamingFetchLike>();
            const result = await runMigrateBackendCommand({
                direction: "hyperdrive-to-d1",
                fetchImpl,
                fromUrl: "https://new.example.com",
                logger: silentLogger(),
                replace: true,
                toUrl: "https://old.example.com",
                yes: true,
            });

            expect(result.error).toContain("--replace needs --tables");
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it("refuses --replace against a worker that would ignore it, before writing anything", async () => {
            expect.assertions(3);

            const d1 = new Map([["a", "old"]]);
            const legacy = deployments(new Map([["a", "edited on hyperdrive"]]), d1);
            // A worker predating the mode: it never echoes `onConflict`, and treats every existing row as a conflict.
            const fetchImpl: StreamingFetchLike = async (input, init) => {
                const url = new URL(input);

                url.searchParams.delete("onConflict");

                return legacy(url.toString(), init);
            };
            const result = await runMigrateBackendCommand({
                direction: "hyperdrive-to-d1",
                fetchImpl,
                fromToken: "source-token",
                fromUrl: "https://new.example.com",
                logger: silentLogger(),
                out: join(dir, "dump.ndjson"),
                replace: true,
                tables: "settings",
                toToken: "target-token",
                toUrl: "https://old.example.com",
                yes: true,
            });

            expect(result.code).not.toBe(0);
            expect(result.error).toContain("predates ?onConflict=replace");
            expect(d1.get("a")).toBe("old");
        });
    });

    it("refuses the import leg against a remote target when --yes was not passed", async () => {
        expect.assertions(2);

        const ndjson = '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n{"end":true,"rows":1}\n';
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

        const result = await runMigrateBackendCommand({
            direction: "d1-to-hyperdrive",
            fetchImpl,
            fromToken: "source-token",
            fromUrl: "https://old.example.com",
            logger,
            out: join(dir, "dump.ndjson"),
            tables: "settings",
            toToken: "target-token",
            toUrl: "https://new.example.com",
        });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.join("\n")).toContain("--yes");
    });

    it("refuses a self-migration when neither --from-url nor --to-url is given", async () => {
        expect.assertions(3);

        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };
        const calls: string[] = [];
        const fetchImpl = recordingFetch(calls);

        const result = await runMigrateBackendCommand({ direction: "d1-to-hyperdrive", fetchImpl, logger, out: join(dir, "dump.ndjson"), yes: true });

        expect(result.code).toBe(EXIT_CODE.USAGE);
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

        const result = await runMigrateBackendCommand({
            direction: "d1-to-hyperdrive",
            fetchImpl,
            fromUrl: "https://worker.example.com/",
            logger,
            out: join(dir, "dump.ndjson"),
            toUrl: "https://worker.example.com",
            yes: true,
        });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
        expect(errors.join("\n")).toContain("same deployment");
    });

    it("shreds the private plaintext dump dir even when the import throws", async () => {
        expect.hasAssertions();

        const ndjson = '{"table":"settings","doc":{"_creationTime":1,"_id":"a","key":"x"}}\n{"end":true,"rows":1}\n';
        const errors: string[] = [];
        const logger: Logger = { error: (message: string) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };

        // Export streams rows, but the import batch POST returns a hard failure,
        // which makes runImportCommand throw — the temp dir must still be removed.
        // The dry-run check and its probe are answered by a worker that honours the flag, so the failure lands on the real batch.
        const fetchImpl: StreamingFetchLike = async (input: string) => {
            if (new URL(input).searchParams.get("dryRun") === "true") {
                return checkResponse();
            }

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
        const failed = await runMigrateBackendCommand({
            direction: "d1-to-hyperdrive",
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

describe("lunora migrate apply / status --sql", () => {
    let sqlWorkdir: string;

    beforeEach(() => {
        sqlWorkdir = mkdtempSync(join(tmpdir(), "lunora-cli-migrate-sql-"));

        const migrations = join(sqlWorkdir, "lunora", "migrations");

        mkdirSync(migrations, { recursive: true });
        writeFileSync(join(migrations, "002_drop_emails.sql"), '-- lunora:allow-destructive\nDROP TABLE IF EXISTS "emails";\n', "utf8");
        writeFileSync(join(migrations, "001_create_emails.sql"), 'CREATE TABLE IF NOT EXISTS "emails" ("_id" TEXT);\n', "utf8");
        writeFileSync(join(migrations, ".snapshot.json"), "{}", "utf8");
    });

    afterEach(() => {
        rmSync(sqlWorkdir, { force: true, recursive: true });
    });

    interface SqlCall {
        body: { confirmDestructive: boolean; dryRun: boolean; files: { name: string; sql: string }[] };
        headers?: Record<string, string>;
        url: string;
    }

    // By default the worker answers as a real one does: a result for every file it was sent.
    const recordSql =
        (calls: SqlCall[], status = 200, body?: unknown): FetchLike =>
        async (url, init) => {
            const sent = JSON.parse(init?.body ?? "{}") as SqlCall["body"];

            calls.push({ body: sent, headers: init?.headers, url });

            const payload = body ?? {
                files: (sent.files ?? []).map((file) => {
                    return { destructive: [], name: file.name, skipped: [], state: "applied", statements: [] };
                }),
            };
            const text = JSON.stringify(payload);

            return { json: async () => payload, ok: status >= 200 && status < 300, status, text: async () => text };
        };

    it("sends every .sql file in name order, with the bearer, and confirmDestructive mirrors --yes", async () => {
        expect.assertions(6);

        const calls: SqlCall[] = [];
        const result = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("http://localhost:9999/_lunora/admin/sql-migrations");
        expect(calls[0]?.headers?.authorization).toBe("Bearer s3cret");
        expect(calls[0]?.body.files.map((file) => file.name)).toEqual(["001_create_emails.sql", "002_drop_emails.sql"]);
        expect(calls[0]?.body).toMatchObject({ confirmDestructive: true, dryRun: false });
    });

    it("refuses a non-local target without --yes, and sends nothing", async () => {
        expect.assertions(2);

        const calls: SqlCall[] = [];
        const result = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "https://app.example.workers.dev",
        });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });

    it("a dry run needs no --yes against a remote target, and asks the worker not to run anything", async () => {
        expect.assertions(2);

        const calls: SqlCall[] = [];
        const result = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            dryRun: true,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "https://app.example.workers.dev",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.body.dryRun).toBe(true);
    });

    it("sends nothing and succeeds when there are no SQL files", async () => {
        expect.assertions(2);

        rmSync(join(sqlWorkdir, "lunora", "migrations"), { force: true, recursive: true });

        const calls: SqlCall[] = [];
        const result = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "https://app.example.workers.dev",
        });

        expect(result).toEqual({ code: 0, files: [] });
        expect(calls).toHaveLength(0);
    });

    it("says the worker predates migrate apply when its route answers 404", async () => {
        expect.assertions(2);

        const result = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 404, {}),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(result.code).toBe(EXIT_CODE.NOT_FOUND);
        expect(result.error).toMatch(/predates `migrate apply`/u);
    });

    it("apply --dry-run through the dispatch plans against a remote worker without --yes, and says so", async () => {
        expect.assertions(3);

        const calls: SqlCall[] = [];
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as SqlCall["body"];
            const target = input instanceof Request ? input.url : String(input);

            calls.push({ body: sent, headers: init?.headers as Record<string, string>, url: target });

            return Response.json({
                files: sent.files.map((file) => {
                    return { destructive: [], name: file.name, skipped: [], state: "pending", statements: [] };
                }),
            });
        });

        try {
            const stdout = await captureStdout(async () => {
                await migrateExecute({
                    argument: ["apply"],
                    options: { dryRun: true, format: "json", token: "s3cret", url: "https://app.example.workers.dev" },
                    process: { cwd: sqlWorkdir, exit: () => {} },
                } as unknown as Parameters<typeof migrateExecute>[0]);
            });

            const document = JSON.parse(stdout) as { data: { files: { state: string }[]; subcommand: string } };

            expect(calls).toHaveLength(1);
            expect(calls[0]?.body.dryRun).toBe(true);
            expect(document.data).toMatchObject({ files: [{ state: "pending" }, { state: "pending" }], subcommand: "apply" });
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("--baseline sends the flag, and a dry run that finds a changed file exits CONFLICT", async () => {
        expect.assertions(4);

        const calls: SqlCall[] = [];
        const baselined = await runMigrateSqlCommand({
            baseline: true,
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
            yes: true,
        });

        expect(calls[0]?.body).toMatchObject({ baseline: true, dryRun: false });
        expect(baselined.code).toBe(0);

        const drift = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            dryRun: true,
            fetchImpl: recordSql([], 200, {
                files: [
                    { destructive: [], name: "001_create_emails.sql", skipped: [], state: "changed", statements: [] },
                    { destructive: [], name: "002_drop_emails.sql", skipped: [], state: "applied", statements: [] },
                ],
            }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(drift.code).toBe(EXIT_CODE.CONFLICT);
        expect(drift.error).toMatch(/changed after they were applied: 001_create_emails\.sql/u);
    });

    it("a 200 that does not name every file sent is a failed run, not a success with nothing applied", async () => {
        expect.assertions(4);

        // An SPA fallback or a proxy answers any path with a 200 and a body that is not an apply result.
        const fallback = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 200, "<!doctype html><title>app</title>"),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(fallback.code).toBe(EXIT_CODE.FAILURE);

        const silent = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 200, { files: [{ name: "001_create_emails.sql", state: "applied" }] }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(silent.code).toBe(EXIT_CODE.FAILURE);
        expect(silent.error).toMatch(/without a valid result for every SQL file/u);
        expect(silent.files).toEqual([]);
    });

    it("a non-dry run that leaves a file pending has not finished, so it is a failed run", async () => {
        expect.assertions(2);

        const incomplete = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 200, {
                files: [
                    { destructive: [], name: "001_create_emails.sql", skipped: [], state: "applied", statements: [] },
                    { destructive: [], name: "002_drop_emails.sql", skipped: [], state: "pending", statements: [] },
                ],
            }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(incomplete.code).toBe(EXIT_CODE.FAILURE);
        expect(incomplete.error).toMatch(/002_drop_emails\.sql was not recorded/u);
    });

    it("--baseline-through sends the bound, and the files after it may stay pending", async () => {
        expect.assertions(3);

        const calls: SqlCall[] = [];
        const through = await runMigrateSqlCommand({
            baselineThrough: "001_create_emails.sql",
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls, 200, {
                files: [
                    { destructive: [], name: "001_create_emails.sql", skipped: [], state: "baselined", statements: [] },
                    { destructive: ["DROP TABLE"], name: "002_drop_emails.sql", skipped: [], state: "pending", statements: [] },
                ],
            }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
            yes: true,
        });

        expect(calls[0]?.body).toMatchObject({ baselineThrough: "001_create_emails.sql" });
        expect(through.code).toBe(0);
        expect(through.files.map((file) => file.state)).toEqual(["baselined", "pending"]);
    });

    it("refuses --baseline with --baseline-through, and a --baseline-through that names no file, before any request", async () => {
        expect.assertions(4);

        const calls: SqlCall[] = [];
        const both = await runMigrateSqlCommand({
            baseline: true,
            baselineThrough: "001_create_emails.sql",
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });
        const unknown = await runMigrateSqlCommand({
            baselineThrough: "999_missing.sql",
            cwd: sqlWorkdir,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(both.code).toBe(EXIT_CODE.USAGE);
        expect(unknown.code).toBe(EXIT_CODE.USAGE);
        expect(unknown.error).toMatch(/names no file/u);
        expect(calls).toEqual([]);
    });

    it("says the files exceed the request limit when the worker answers 413", async () => {
        expect.assertions(2);

        const tooLarge = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 413, { error: { code: "PAYLOAD_TOO_LARGE" } }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(tooLarge.code).not.toBe(0);
        expect(tooLarge.error).toMatch(/8 MiB/u);
    });

    it("skips with a warning, and succeeds, when the worker has no D1 plane to run the files on", async () => {
        expect.assertions(2);

        const skipped = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 400, { error: { code: "SQL_MIGRATIONS_NOT_CONFIGURED", message: "no D1 plane" } }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(skipped.code).toBe(0);
        expect(skipped.error).toBeUndefined();
    });

    it("says a token without the migrations scope needs one, and names the command that mints it", async () => {
        expect.assertions(2);

        const unscoped = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 403, { error: { code: "ADMIN_SCOPE_REQUIRED", message: "no scope" } }),
            logger: silentLogger(),
            token: "named-token",
            url: "http://localhost:9999",
        });

        expect(unscoped.code).toBe(EXIT_CODE.PERMISSION);
        expect(unscoped.error).toMatch(/lunora admin-token create <name> --scope migrations/u);
    });

    it("says a file's root-only statements need the root token, rather than printing the raw refusal", async () => {
        expect.assertions(2);

        const rootOnly = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 409, { error: { code: "MIGRATION_ROOT_REQUIRED", message: "root only" } }),
            logger: silentLogger(),
            token: "scoped-token",
            url: "http://localhost:9999",
        });

        expect(rootOnly.code).not.toBe(0);
        expect(rootOnly.error).toMatch(/Run it with the root admin token/u);
    });

    it("a dry run that the real apply would refuse exits CONFLICT and names the files", async () => {
        expect.assertions(2);

        const refused = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            dryRun: true,
            fetchImpl: recordSql([], 200, {
                files: [
                    { destructive: [], name: "001_create_emails.sql", rootOnly: [], skipped: [], state: "pending", statements: [] },
                    { destructive: ["DROP TABLE"], name: "002_drop_emails.sql", rootOnly: [], skipped: [], state: "pending", statements: [] },
                ],
                refused: ["002_drop_emails.sql"],
            }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(refused.code).toBe(EXIT_CODE.CONFLICT);
        expect(refused.error).toMatch(/1 SQL file\(s\) would be refused when applied: 002_drop_emails\.sql/u);
    });

    it("refuses a --baseline-through that names no file, even when the directory has no SQL files", async () => {
        expect.assertions(2);

        const empty = mkdtempSync(join(tmpdir(), "lunora-cli-migrate-empty-"));
        const calls: SqlCall[] = [];

        const result = await runMigrateSqlCommand({
            baselineThrough: "001_create_emails.sql",
            cwd: empty,
            fetchImpl: recordSql(calls),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toStrictEqual([]);
    });

    it("sends only the files under lunora/migrations/, not a directory that has a .sql name", async () => {
        expect.assertions(2);

        const dir = mkdtempSync(join(tmpdir(), "lunora-cli-migrate-dirname-"));

        mkdirSync(join(dir, "lunora", "migrations", "notes.sql"), { recursive: true });
        writeFileSync(join(dir, "lunora", "migrations", "real.sql"), "CREATE TABLE real (id TEXT);");

        const calls: SqlCall[] = [];
        const result = await runMigrateSqlCommand({
            cwd: dir,
            dryRun: true,
            fetchImpl: recordSql(calls, 200, {
                files: [{ destructive: [], name: "real.sql", rootOnly: [], skipped: [], state: "pending", statements: [] }],
            }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(calls[0]?.body.files.map((file) => file.name)).toStrictEqual(["real.sql"]);
        expect(result.code).toBe(0);
    });

    it("returns the worker's per-file plan, and a refused run carries the HTTP status", async () => {
        expect.assertions(3);

        const plan = {
            files: [
                { destructive: [], name: "001_create_emails.sql", skipped: [], state: "applied", statements: [] },
                { destructive: [], name: "002_drop_emails.sql", skipped: [], state: "pending", statements: [] },
            ],
        };
        const applied = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 200, plan),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(applied.files).toEqual(plan.files);

        const refused = await runMigrateSqlCommand({
            cwd: sqlWorkdir,
            fetchImpl: recordSql([], 409, { code: "MIGRATION_DESTRUCTIVE" }),
            logger: silentLogger(),
            token: "s3cret",
            url: "http://localhost:9999",
        });

        expect(refused.code).not.toBe(0);
        expect(refused.error).toMatch(/HTTP 409/u);
    });
});
