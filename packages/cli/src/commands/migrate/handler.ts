/**
 * `lunora migrate generate` — diff `lunora/schema.ts` (filtered to `.global()`
 * tables) against `lunora/migrations/.snapshot.json` and emit a timestamped
 * SQL migration file.
 *
 * The applied migrations themselves still go through `@lunora/d1`'s
 * `MigrationRunner` at deploy time — this command only **produces** the SQL.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { discoverMigrations, discoverSchema } from "@lunora/codegen";
import { isInteractive, promptSelect, promptText } from "@lunora/config";
import { LunoraError } from "@lunora/errors";
import { join } from "@visulima/path";
import { Project } from "ts-morph";

import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { SchemaSnapshot } from "../../util/migration-diff";
import { diffSnapshots, renderMigrationFile } from "../../util/migration-diff";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import schemaIrToSnapshot from "../../util/schema-snapshot";
import { runExportCommand, runImportCommand } from "../data-transfer";
import type { FetchLike } from "../run/handler";
import type { MigrateOptions } from "./index";

interface MigrateGenerateCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Migration name slug. Defaults to `auto`. */
    name?: string;
    /** Override the current time — used by tests for deterministic file names. */
    now?: () => Date;
}

interface MigrateGenerateCommandResult {
    code: number;
    /** Whether the diff was empty (no changes detected). */
    empty: boolean;
    /** Absolute path to the migration file (empty string when nothing was written). */
    migrationFile: string;
}

const SNAPSHOT_FILENAME = ".snapshot.json";

const NON_ALPHANUMERIC = /[^\da-z]+/gu;

/** Strip leading and trailing occurrences of `char` without a backtracking regex. */
const trimChar = (value: string, char: string): string => {
    let start = 0;
    let end = value.length;

    while (start < end && value[start] === char) {
        start += 1;
    }

    while (end > start && value[end - 1] === char) {
        end -= 1;
    }

    return value.slice(start, end);
};

const slugify = (input: string): string => {
    const slug = trimChar(input.toLowerCase().replaceAll(NON_ALPHANUMERIC, "_"), "_");

    return slug === "" ? "auto" : slug;
};

const formatTimestamp = (now: Date): string => {
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");

    return `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(
        now.getUTCMinutes(),
    )}${pad(now.getUTCSeconds())}`;
};

const loadSnapshot = (path: string): SchemaSnapshot | undefined => {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as SchemaSnapshot;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- parsed is untrusted file content cast to SchemaSnapshot; the version may be anything on disk
        if (parsed.version !== 1) {
            throw new LunoraError("INTERNAL", `unsupported snapshot version: ${parsed.version as unknown as string}`);
        }

        return parsed;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        throw new LunoraError("INTERNAL", `failed to read ${path}: ${message}`, { cause: error });
    }
};

const runMigrateGenerateCommand = (options: MigrateGenerateCommandOptions): MigrateGenerateCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const schemaPath = join(cwd, "lunora", "schema.ts");

    if (!existsSync(schemaPath)) {
        options.logger.error(`schema not found: ${schemaPath} — run \`vis generate lunora-table --name=<name>\` to create one`);

        return { code: 1, empty: true, migrationFile: "" };
    }

    // Parse the current schema with ts-morph (reusing the codegen discoverer).
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const schemaIr = discoverSchema(project, schemaPath);
    const nextSnapshot = schemaIrToSnapshot(schemaIr);

    const migrationsDirectory = join(cwd, "lunora", "migrations");
    const snapshotPath = join(migrationsDirectory, SNAPSHOT_FILENAME);

    let previousSnapshot: SchemaSnapshot | undefined;

    try {
        previousSnapshot = loadSnapshot(snapshotPath);
    } catch (error: unknown) {
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { code: 1, empty: true, migrationFile: "" };
    }

    const diff = diffSnapshots(previousSnapshot, nextSnapshot);

    if (diff.empty) {
        options.logger.info("no schema changes detected — snapshot is already up to date");

        return { code: 0, empty: true, migrationFile: "" };
    }

    const nowFunction = options.now ?? (() => new Date());
    const now = nowFunction();
    const slug = slugify(options.name ?? "auto");
    const timestamp = formatTimestamp(now);
    const filename = `${timestamp}_${slug}.sql`;
    const migrationFile = join(migrationsDirectory, filename);

    mkdirSync(migrationsDirectory, { recursive: true });

    const body = renderMigrationFile(slug, diff, now.toISOString());

    writeFileSync(migrationFile, body, "utf8");
    writeFileSync(snapshotPath, `${JSON.stringify(nextSnapshot, undefined, 4)}\n`, "utf8");

    options.logger.success(`wrote ${migrationFile}`);

    if (diff.unsupported.length > 0) {
        options.logger.warn(`${String(diff.unsupported.length)} unsupported diff(s) — see the comment block in ${filename} and write the SQL manually`);
    }

    return { code: 0, empty: false, migrationFile };
};

const DATA_MIGRATIONS_FILENAME = "migrations.ts";
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/u;

/**
 * JS reserved words that are syntactically invalid as a `const` binding name —
 * `export const default = …` / `export const return = …` won't compile. The
 * camelCase export identifier must not be one of these (nor digit-leading,
 * which {@link IDENTIFIER_PATTERN} already rejects).
 */
const RESERVED_WORDS = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
]);
const DEFINE_MIGRATION_IMPORT = `import { defineMigration } from "@lunora/server";`;
const RUN_MIGRATION_OP = "__lunora_admin__:runMigration";
const MIGRATION_STATUS_OP = "__lunora_admin__:migrationStatus";
const MIGRATE_ENDPOINT_PATH = "/_lunora/migrate";

/** Convert a free-text migration name to kebab-case — the `id` and per-shard run-state key. */
const kebabCase = (input: string): string => trimChar(input.trim().toLowerCase().replaceAll(NON_ALPHANUMERIC, "-"), "-");

/** Build a camelCase export identifier derived from the kebab slug. */
const camelCase = (slug: string): string =>
    slug
        .split("-")
        .filter((part) => part.length > 0)
        .map((part, index) => {
            if (index === 0) {
                return part;
            }

            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join("");

interface MigrateCreateCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Free-text migration name; slugified into the `id` and export identifier. */
    name: string;

    /**
     * Inject a custom table prompt (tests, non-TTY callers). Receives the
     * table names discovered in `lunora/schema.ts` (possibly empty) and
     * resolves to the chosen table, or `undefined` to abort.
     */
    promptTable?: (tables: ReadonlyArray<string>) => Promise<string | undefined>;
    /** Target table the migration iterates. Prompted for interactively when omitted. */
    table?: string;
}

interface MigrateCreateCommandResult {
    code: number;
    /** Absolute path to `lunora/migrations.ts` (empty string on failure). */
    file: string;
}

/** Table names declared in `lunora/schema.ts`, or `[]` when the schema is missing or unparsable. */
const discoverKnownTables = (cwd: string): string[] => {
    const schemaPath = join(cwd, "lunora", "schema.ts");

    if (!existsSync(schemaPath)) {
        return [];
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true });

        return discoverSchema(project, schemaPath).tables.map((table) => table.name);
    } catch {
        // Best-effort convenience only — an unparsable schema just means no suggestions.
        return [];
    }
};

/**
 * Default interactive table prompt: a numbered pick over the schema's known
 * tables when any were discovered, else a free-text question.
 */
const promptForTable = async (tables: ReadonlyArray<string>): Promise<string | undefined> => {
    if (tables.length > 0) {
        return promptSelect(
            "Which table does this migration iterate?",
            tables.map((name) => {
                return { label: name, value: name };
            }),
        );
    }

    return promptText("Target table for the migration: ");
};

/**
 * Resolve the target table for `migrate create`: the explicit `--table` when
 * given, else an interactive prompt (injected or the default). Returns
 * `undefined` after logging when the table cannot be resolved — omitted in a
 * non-interactive context, or the prompt was aborted.
 */
const resolveCreateTable = async (cwd: string, options: MigrateCreateCommandOptions): Promise<string | undefined> => {
    if (options.table !== undefined) {
        return options.table;
    }

    const prompt = options.promptTable ?? (isInteractive() ? promptForTable : undefined);

    if (prompt === undefined) {
        options.logger.error("migrate create requires a target table when not running interactively — re-run with --table <table>");

        return undefined;
    }

    const answer = await prompt(discoverKnownTables(cwd));
    const table = answer?.trim();

    if (table === undefined || table === "") {
        options.logger.error("no table selected — re-run with --table <table>");

        return undefined;
    }

    return table;
};

/**
 * `lunora migrate create &lt;name>` — scaffold a `defineMigration({...})` block in
 * `lunora/migrations.ts`, appending to the file (and creating it with the
 * import) when it already exists. Refuses to clobber an existing migration of
 * the same id or export name. The target table comes from `--table`, or from
 * an interactive prompt when omitted (a non-interactive run without `--table`
 * fails instead of scaffolding a placeholder).
 */
const runMigrateCreateCommand = async (options: MigrateCreateCommandOptions): Promise<MigrateCreateCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const slug = kebabCase(options.name);

    if (slug === "") {
        options.logger.error(`invalid migration name: "${options.name}" — must contain at least one alphanumeric character`);

        return { code: 1, file: "" };
    }

    const exportName = camelCase(slug);

    // `exportName` is written verbatim as `export const ${exportName} = …`. A slug
    // that camelCases to a digit-leading value (e.g. `123-backfill` → `123Backfill`)
    // or a reserved word (`class`, `default`, …) yields uncompilable source that
    // breaks the whole lunora/migrations.ts module — reject before writing.
    if (!IDENTIFIER_PATTERN.test(exportName) || RESERVED_WORDS.has(exportName)) {
        options.logger.error(
            `invalid migration name: "${options.name}" derives the export \`${exportName}\`, which is not a valid identifier — pick a name that starts with a letter and isn't a reserved word`,
        );

        return { code: 1, file: "" };
    }

    const table = await resolveCreateTable(cwd, options);

    if (table === undefined) {
        return { code: 1, file: "" };
    }

    // `table` is written verbatim into generated TypeScript (`table: "..."`),
    // so it must be a bare identifier — otherwise a crafted `--table` (or
    // prompted) value can inject arbitrary source into lunora/migrations.ts.
    if (!IDENTIFIER_PATTERN.test(table)) {
        options.logger.error(`invalid table: "${table}" — must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*)`);

        return { code: 1, file: "" };
    }

    const lunoraDirectory = join(cwd, "lunora");
    const file = join(lunoraDirectory, DATA_MIGRATIONS_FILENAME);

    let content = existsSync(file) ? readFileSync(file, "utf8") : "";

    if (content.includes(`id: "${slug}"`) || new RegExp(String.raw`\bexport const ${exportName}\b`, "u").test(content)) {
        options.logger.error(`a migration with id "${slug}" (export \`${exportName}\`) already exists in ${file}`);

        return { code: 1, file: "" };
    }

    if (content.trim() === "") {
        content = `${DEFINE_MIGRATION_IMPORT}\n`;
    } else if (!content.includes(DEFINE_MIGRATION_IMPORT)) {
        content = `${DEFINE_MIGRATION_IMPORT}\n${content}`;
    }

    const block = `export const ${exportName} = defineMigration({
    id: "${slug}",
    table: "${table}",
    up: (document) => document,
});`;

    mkdirSync(lunoraDirectory, { recursive: true });
    writeFileSync(file, `${content.trimEnd()}\n\n${block}\n`, "utf8");

    options.logger.success(`scaffolded migration "${slug}" in ${file}`);

    return { code: 0, file };
};

interface MigrateDataCommandOptions {
    /** Rows per batch forwarded to the per-shard runner. */
    batchSize?: number;
    cwd?: string;
    /** Preview without rewriting rows (`up`/`down` only). */
    dryRun?: boolean;
    fetchImpl?: FetchLike;
    /** Migration id to run; resolved to its table via local discovery. */
    id: string;
    logger: Logger;
    /** Cap on batches processed this invocation (the `--steps` flag → runner `maxBatches`). */
    maxBatches?: number;
    /** Guard: refuse to target the implicit localhost URL. */
    prod?: boolean;
    subcommand: "down" | "status" | "up";
    /** Admin bearer token; falls back to `LUNORA_ADMIN_TOKEN`. */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
    /** Required alongside `--prod` for `up`/`down` — confirms running against production. */
    yes?: boolean;
}

interface MigrateDataCommandResult {
    body: unknown;
    code: number;
    requestUrl: string;
}

/** Resolve a migration id to its declared table by scanning `lunora/`. */
const resolveMigrationTable = (cwd: string, id: string): string | undefined => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const migrations = discoverMigrations(project, join(cwd, "lunora"));

    return migrations.find((migration) => migration.id === id)?.table;
};

interface MigrateDataRequest {
    fetchImpl: FetchLike;
    requestUrl: string;
    table: string;
    token: string;
}

/** Resolve the table for `options.id`, logging and returning `undefined` on any failure. */
const resolveValidatedTable = (cwd: string, options: MigrateDataCommandOptions): string | undefined => {
    let table: string | undefined;

    try {
        table = resolveMigrationTable(cwd, options.id);
    } catch (error: unknown) {
        options.logger.error(error instanceof Error ? error.message : String(error));

        return undefined;
    }

    if (table === undefined) {
        options.logger.error(`migration "${options.id}" not found under lunora/ — declare it with defineMigration({ id: "${options.id}", ... })`);

        return undefined;
    }

    if (table === "") {
        options.logger.error(`migration "${options.id}" must declare \`table\` as a static string literal`);

        return undefined;
    }

    return table;
};

/**
 * Validate the guards (`--prod`/`--yes`), token, target table, and fetch impl
 * for a data migration. Returns `undefined` after logging when any check fails.
 */
const resolveMigrateDataRequest = (options: MigrateDataCommandOptions): MigrateDataRequest | undefined => {
    const cwd = options.cwd ?? process.cwd();

    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to migrate the implicit localhost worker)");

        return undefined;
    }

    if (options.prod && (options.subcommand === "up" || options.subcommand === "down") && !options.yes) {
        options.logger.error(`migrate ${options.subcommand} --prod runs the migration against production. Re-run with --yes to confirm.`);

        return undefined;
    }

    const token = options.token ?? process.env.LUNORA_ADMIN_TOKEN;

    if (!token) {
        options.logger.error("admin token required — pass --token or set LUNORA_ADMIN_TOKEN");

        return undefined;
    }

    const table = resolveValidatedTable(cwd, options);

    if (table === undefined) {
        return undefined;
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return undefined;
    }

    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    return { fetchImpl, requestUrl: `${baseUrl}${MIGRATE_ENDPOINT_PATH}`, table, token };
};

/** Build the RPC args payload for a data migration. */
const buildMigrateArgs = (options: MigrateDataCommandOptions): Record<string, unknown> => {
    const args: Record<string, unknown> = { id: options.id };

    if (options.subcommand === "status") {
        return args;
    }

    args.direction = options.subcommand;

    if (options.dryRun) {
        args.dryRun = true;
    }

    if (options.batchSize !== undefined) {
        args.batchSize = options.batchSize;
    }

    if (options.maxBatches !== undefined) {
        args.maxBatches = options.maxBatches;
    }

    return args;
};

/**
 * `lunora migrate up|down|status &lt;id>` — drive the cross-shard data-migration
 * orchestrator. Resolves the migration's table locally, then POSTs a migration
 * admin RPC to the Worker's `/_lunora/migrate` endpoint, which fans it out to
 * every live shard of that table and rolls up the per-shard outcomes.
 */
const runMigrateDataCommand = async (options: MigrateDataCommandOptions): Promise<MigrateDataCommandResult> => {
    const request = resolveMigrateDataRequest(options);

    if (request === undefined) {
        return { body: undefined, code: 1, requestUrl: "" };
    }

    const { fetchImpl, requestUrl, table, token } = request;
    const functionPath = options.subcommand === "status" ? MIGRATION_STATUS_OP : RUN_MIGRATION_OP;
    const args = buildMigrateArgs(options);

    options.logger.info(`POST ${requestUrl} -> ${options.subcommand} ${options.id} (table "${table}")`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify({ args, functionPath, table }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    const text = await response.text();

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    options.logger.info(JSON.stringify(body, undefined, 2));

    return { body, code: response.ok ? 0 : 1, requestUrl };
};

interface MigrateToHyperdriveOptions {
    batchSize?: number;
    /** Injected fetch (tests); defaults to the global `fetch` inside the export/import helpers. */
    fetchImpl?: Parameters<typeof runExportCommand>[0]["fetchImpl"];
    fromToken?: string;
    /** Source deployment (D1-backed). Defaults to `--url`/localhost. */
    fromUrl?: string;
    logger: Logger;
    /** Keep the intermediate NDJSON dump at this path instead of a private temp dir. */
    out?: string;
    prod?: boolean;
    /** Comma-separated `.global()` tables to move; omit to move every global table. */
    tables?: string;
    toToken?: string;
    /** Target deployment (Hyperdrive-backed). Defaults to `--url`/localhost. */
    toUrl?: string;
}

/**
 * `lunora migrate d1-to-hyperdrive` — copy `.global()` table data from a
 * D1-backed deployment into a Hyperdrive-backed one. A thin, guided
 * orchestration over the existing admin export/import: it streams the source's
 * global rows to an NDJSON dump, imports them into the target (whose
 * `.global({ backend: "hyperdrive" })` tables route the writes to Hyperdrive
 * via the store core), and verifies the row counts match.
 *
 * Typical blue-green flow: deploy the new Hyperdrive-backed worker alongside
 * the old D1 one, then run this with `--from-url` (the D1 deployment) and
 * `--to-url` (the Hyperdrive deployment).
 * For an in-place switch, export first (this command, same `--from`/`--to`
 * URL before the schema swap is risky) — the skill documents both.
 */
const runMigrateToHyperdriveCommand = async (options: MigrateToHyperdriveOptions): Promise<{ code: number }> => {
    const { logger } = options;
    const fromUrl = options.fromUrl ?? options.toUrl;
    const toUrl = options.toUrl ?? options.fromUrl;

    // Refuse a self-migration: with only one URL given, the source and target
    // resolve to the same deployment, so the export and import would run against
    // one database (a no-op that misreports "counts match"). Require distinct URLs.
    if (fromUrl !== undefined && fromUrl === toUrl) {
        logger.error(
            "source and target are the same deployment — pass distinct --from-url and --to-url so the D1 export and Hyperdrive import don't run against one database",
        );

        return { code: 1 };
    }

    // When no --out is given, stage the (plaintext, cross-tenant) dump inside a
    // private 0700 temp dir so other local users can't read it through /tmp.
    const temporaryDirectory = options.out === undefined ? mkdtempSync(join(tmpdir(), "lunora-d1ps-")) : undefined;
    const dumpPath = options.out ?? join(temporaryDirectory as string, "dump.ndjson");

    try {
        logger.info(`Exporting .global() data from the D1 source (${fromUrl ?? "http://localhost:8787"}) …`);

        const exportResult = await runExportCommand({
            fetchImpl: options.fetchImpl,
            logger,
            out: dumpPath,
            prod: options.prod,
            tables: options.tables,
            token: options.fromToken,
            url: fromUrl,
        });

        if (exportResult.code !== 0) {
            return { code: exportResult.code };
        }

        logger.info(`Exported ${String(exportResult.rows)} row(s) (${String(exportResult.bytes)} bytes).`);
        logger.info(`Importing into the Hyperdrive target (${toUrl ?? "http://localhost:8787"}) …`);

        const importResult = await runImportCommand({
            batchSize: options.batchSize,
            fetchImpl: options.fetchImpl,
            file: dumpPath,
            logger,
            prod: options.prod,
            token: options.toToken,
            url: toUrl,
        });

        if (importResult.code !== 0) {
            return { code: importResult.code };
        }

        if (importResult.inserted === exportResult.rows) {
            logger.info(
                `✓ Migrated ${String(exportResult.rows)} row(s) — counts match. Verify your app reads from Hyperdrive, then decommission the D1 binding.`,
            );
        } else {
            logger.warn(
                `Imported ${String(importResult.inserted)} of ${String(exportResult.rows)} exported row(s) — the remainder likely already existed in the target (see conflicts above). Re-run after resolving, or inspect the dump with --out.`,
            );
        }

        return { code: 0 };
    } finally {
        // Always shred the private temp dir (and the plaintext, cross-tenant dump
        // inside it) — even when export/import throws or returns early — unless the
        // caller asked to keep the dump via --out. Leaving it behind would strand a
        // full plaintext export in /tmp until OS cleanup.
        if (temporaryDirectory !== undefined) {
            rmSync(temporaryDirectory, { force: true, recursive: true });
        }
    }
};

/** `lunora migrate &lt;subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<MigrateOptions> = defineHandler<MigrateOptions>(({ argument, cwd, logger, options }) => {
    const sub = argument[0];

    if (sub === "generate") {
        return runMigrateGenerateCommand({ cwd, logger, name: argument[1] ?? options.name });
    }

    if (sub === "d1-to-hyperdrive") {
        return runMigrateToHyperdriveCommand({
            batchSize: options.batchSize,
            fromToken: options.fromToken ?? options.token,
            fromUrl: options.fromUrl ?? options.url,
            logger,
            out: options.out,
            prod: options.prod === true,
            tables: options.tables,
            toToken: options.toToken ?? options.token,
            toUrl: options.toUrl ?? options.url,
        });
    }

    if (sub === "create") {
        const name = argument[1] ?? options.name;

        if (!name) {
            logger.error("migrate create requires a name. Usage: lunora migrate create <name> [--table <table>]");

            return { code: 1 };
        }

        return runMigrateCreateCommand({ cwd, logger, name, table: options.table });
    }

    if (sub === "up" || sub === "down" || sub === "status") {
        const id = argument[1] ?? options.name;

        if (!id) {
            logger.error(`migrate ${sub} requires a migration id. Usage: lunora migrate ${sub} <id>`);

            return { code: 1 };
        }

        return runMigrateDataCommand({
            batchSize: options.batchSize,
            cwd,
            dryRun: options.dryRun === true,
            id,
            logger,
            maxBatches: options.steps,
            prod: options.prod === true,
            subcommand: sub,
            token: options.token,
            url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
            yes: options.yes === true,
        });
    }

    logger.error(`unknown migrate subcommand: "${sub ?? ""}" — expected generate | create | up | down | status`);

    return { code: 1 };
});

export { execute };
export type {
    MigrateCreateCommandOptions,
    MigrateCreateCommandResult,
    MigrateDataCommandOptions,
    MigrateDataCommandResult,
    MigrateGenerateCommandOptions,
    MigrateGenerateCommandResult,
};
export { runMigrateCreateCommand, runMigrateDataCommand, runMigrateGenerateCommand, runMigrateToHyperdriveCommand };
