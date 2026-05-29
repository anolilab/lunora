/**
 * `cirrus migrate generate` — diff `cirrus/schema.ts` (filtered to `.global()`
 * tables) against `cirrus/migrations/.snapshot.json` and emit a timestamped
 * SQL migration file.
 *
 * The applied migrations themselves still go through `@cirrus/d1`'s
 * {@link MigrationRunner} at deploy time — this command only **produces**
 * the SQL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { discoverMigrations, discoverSchema } from "@cirrus/codegen";
import { join } from "@visulima/path";
import { Project } from "ts-morph";

import type { Logger } from "../util/logger.js";
import type { SchemaSnapshot } from "../util/migration-diff.js";
import { diffSnapshots, renderMigrationFile } from "../util/migration-diff.js";
import { schemaIrToSnapshot } from "../util/schema-snapshot.js";
import type { FetchLike } from "./run.js";

export interface MigrateGenerateCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Migration name slug. Defaults to `auto`. */
    name?: string;
    /** Override the current time — used by tests for deterministic file names. */
    now?: () => Date;
}

export interface MigrateGenerateCommandResult {
    code: number;
    /** Whether the diff was empty (no changes detected). */
    empty: boolean;
    /** Absolute path to the migration file (empty string when nothing was written). */
    migrationFile: string;
}

const SNAPSHOT_FILENAME = ".snapshot.json";

const slugify = (input: string): string =>
    input
        .toLowerCase()
        .replaceAll(/[^\da-z]+/gu, "_")
        .replaceAll(/^_+|_+$/gu, "")
        .replace(/^$/u, "auto");

const formatTimestamp = (now: Date): string => {
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");

    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(
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

        if (parsed.version !== 1) {
            throw new Error(`unsupported snapshot version: ${parsed.version as unknown as string}`);
        }

        return parsed;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        throw new Error(`failed to read ${path}: ${message}`);
    }
};

export const runMigrateGenerateCommand = (options: MigrateGenerateCommandOptions): MigrateGenerateCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const schemaPath = join(cwd, "cirrus", "schema.ts");

    if (!existsSync(schemaPath)) {
        options.logger.error(`schema not found: ${schemaPath} — run \`vis generate cirrus-table --name=<name>\` to create one`);

        return { code: 1, empty: true, migrationFile: "" };
    }

    // Parse the current schema with ts-morph (reusing the codegen discoverer).
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const schemaIr = discoverSchema(project, schemaPath);
    const nextSnapshot = schemaIrToSnapshot(schemaIr);

    const migrationsDir = join(cwd, "cirrus", "migrations");
    const snapshotPath = join(migrationsDir, SNAPSHOT_FILENAME);

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

    const nowFn = options.now ?? (() => new Date());
    const now = nowFn();
    const slug = slugify(options.name ?? "auto");
    const timestamp = formatTimestamp(now);
    const filename = `${timestamp}_${slug}.sql`;
    const migrationFile = join(migrationsDir, filename);

    mkdirSync(migrationsDir, { recursive: true });

    const body = renderMigrationFile(slug, diff, now.toISOString());

    writeFileSync(migrationFile, body, "utf8");
    writeFileSync(snapshotPath, `${JSON.stringify(nextSnapshot, null, 4)}\n`, "utf8");

    options.logger.success(`wrote ${migrationFile}`);

    if (diff.unsupported.length > 0) {
        options.logger.warn(`${diff.unsupported.length} unsupported diff(s) — see the comment block in ${filename} and write the SQL manually`);
    }

    return { code: 0, empty: false, migrationFile };
};

const DATA_MIGRATIONS_FILENAME = "migrations.ts";
const DEFINE_MIGRATION_IMPORT = `import { defineMigration } from "@cirrus/server";`;
const RUN_MIGRATION_OP = "__cirrus_admin__:runMigration";
const MIGRATION_STATUS_OP = "__cirrus_admin__:migrationStatus";
const MIGRATE_ENDPOINT_PATH = "/_cirrus/migrate";

/** kebab-case a free-text migration name — the `id` and per-shard run-state key. */
const kebabCase = (input: string): string =>
    input
        .trim()
        .toLowerCase()
        .replaceAll(/[^\da-z]+/gu, "-")
        .replaceAll(/^-+|-+$/gu, "");

/** camelCase export identifier derived from the kebab slug. */
const camelCase = (slug: string): string =>
    slug
        .split("-")
        .filter((part) => part.length > 0)
        .map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
        .join("");

export interface MigrateCreateCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Free-text migration name; slugified into the `id` and export identifier. */
    name: string;
    /** Target table the migration iterates. Left as a TODO placeholder when omitted. */
    table?: string;
}

export interface MigrateCreateCommandResult {
    code: number;
    /** Absolute path to `cirrus/migrations.ts` (empty string on failure). */
    file: string;
}

/**
 * `cirrus migrate create <name>` — scaffold a `defineMigration({...})` block in
 * `cirrus/migrations.ts`, appending to the file (and creating it with the
 * import) when it already exists. Refuses to clobber an existing migration of
 * the same id or export name.
 */
export const runMigrateCreateCommand = (options: MigrateCreateCommandOptions): MigrateCreateCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const slug = kebabCase(options.name);

    if (slug === "") {
        options.logger.error(`invalid migration name: "${options.name}" — must contain at least one alphanumeric character`);

        return { code: 1, file: "" };
    }

    const exportName = camelCase(slug);
    const table = options.table ?? "TODO_table";
    const cirrusDirectory = join(cwd, "cirrus");
    const file = join(cirrusDirectory, DATA_MIGRATIONS_FILENAME);

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

    mkdirSync(cirrusDirectory, { recursive: true });
    writeFileSync(file, `${content.trimEnd()}\n\n${block}\n`, "utf8");

    options.logger.success(`scaffolded migration "${slug}" in ${file}`);

    if (options.table === undefined) {
        options.logger.warn(`set the \`table\` field on "${slug}" — it defaults to "${table}"`);
    }

    return { code: 0, file };
};

export interface MigrateDataCommandOptions {
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
    /** Admin bearer token; falls back to `CIRRUS_ADMIN_TOKEN`. */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
}

export interface MigrateDataCommandResult {
    body: unknown;
    code: number;
    requestUrl: string;
}

/** Resolve a migration id to its declared table by scanning `cirrus/`. */
const resolveMigrationTable = (cwd: string, id: string): string | undefined => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const migrations = discoverMigrations(project, join(cwd, "cirrus"));

    return migrations.find((migration) => migration.id === id)?.table;
};

/**
 * `cirrus migrate up|down|status <id>` — drive the cross-shard data-migration
 * orchestrator. Resolves the migration's table locally, then POSTs a migration
 * admin RPC to the Worker's `/_cirrus/migrate` endpoint, which fans it out to
 * every live shard of that table and rolls up the per-shard outcomes.
 */
export const runMigrateDataCommand = async (options: MigrateDataCommandOptions): Promise<MigrateDataCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to migrate the implicit localhost worker)");

        return { body: undefined, code: 1, requestUrl: "" };
    }

    const token = options.token ?? process.env.CIRRUS_ADMIN_TOKEN;

    if (!token) {
        options.logger.error("admin token required — pass --token or set CIRRUS_ADMIN_TOKEN");

        return { body: undefined, code: 1, requestUrl: "" };
    }

    let table: string | undefined;

    try {
        table = resolveMigrationTable(cwd, options.id);
    } catch (error: unknown) {
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { body: undefined, code: 1, requestUrl: "" };
    }

    if (table === undefined) {
        options.logger.error(`migration "${options.id}" not found under cirrus/ — declare it with defineMigration({ id: "${options.id}", ... })`);

        return { body: undefined, code: 1, requestUrl: "" };
    }

    if (table === "") {
        options.logger.error(`migration "${options.id}" must declare \`table\` as a static string literal`);

        return { body: undefined, code: 1, requestUrl: "" };
    }

    const baseUrl = (options.url ?? "http://localhost:8787").replace(/\/$/u, "");
    const requestUrl = `${baseUrl}${MIGRATE_ENDPOINT_PATH}`;

    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    const functionPath = options.subcommand === "status" ? MIGRATION_STATUS_OP : RUN_MIGRATION_OP;

    const args: Record<string, unknown> = { id: options.id };

    if (options.subcommand !== "status") {
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
    }

    options.logger.info(`POST ${requestUrl} -> ${options.subcommand} ${options.id} (table "${table}")`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify({ args, functionPath, table }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    let body: unknown;

    try {
        body = await response.json();
    } catch {
        body = await response.text();
    }

    options.logger.info(JSON.stringify(body, undefined, 2));

    return { body, code: response.ok ? 0 : 1, requestUrl };
};
