import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { join } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { Connection } from "./connect";
import { connect, dialectFromUrl } from "./connect";
import type { EmittedFile } from "./emit";
import { emitIntrospection } from "./emit";
import type { IntrospectOptions } from "./index";
import { mergeIntoSchema } from "./merge";
import type { IntrospectedDatabase, SqlDialect } from "./model";
import { readDatabase } from "./read-database";

interface IntrospectCommandOptions {
    /** Inject an already-open connection (tests). When set, `url` is not read. */
    connection?: Connection;
    cwd?: string;
    /** Dialect to pair with an injected `connection`. Ignored when connecting from `url`, where the scheme decides. */
    dialect?: SqlDialect;
    /** Write nothing; print what would be written. */
    dryRun?: boolean;
    /** Overwrite files that already exist. */
    force?: boolean;
    logger: Logger;
    /** Emit `list`/`get` procedure modules alongside the schema. Defaults to `true`. */
    procedures?: boolean;
    /** Postgres schema (default `public`) or MySQL database name. */
    schema?: string;
    /** Only introspect these tables. */
    tables?: ReadonlyArray<string>;
    url?: string;
}

interface IntrospectCommandResult {
    code: number;
    /** Paths (relative to `lunora/`) actually written. */
    written: string[];
}

/**
 * Resolve which server package the emitted imports should point at. A project
 * depending on the `lunorash` umbrella gets `lunorash/server`; everything else
 * gets `@lunora/server`. Mirrors the rule codegen uses for `_generated/*`.
 */
const resolveServerImport = (cwd: string): string => {
    try {
        const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        return manifest.dependencies?.lunorash === undefined && manifest.devDependencies?.lunorash === undefined ? "@lunora/server" : "lunorash/server";
    } catch {
        return "@lunora/server";
    }
};

/** Write one emitted file, honoring `--force` and `--dry-run`. Returns `true` when it was written. */
const writeEmittedFile = async (file: EmittedFile, directory: string, options: IntrospectCommandOptions): Promise<boolean> => {
    const target = join(directory, file.path);

    if (existsSync(target) && options.force !== true) {
        options.logger.warn(`skipped lunora/${file.path} — it already exists (pass --force to overwrite)`);

        return false;
    }

    if (options.dryRun === true) {
        options.logger.info(`would write lunora/${file.path} (${String(file.contents.split("\n").length)} lines)`);

        return false;
    }

    await mkdir(directory, { recursive: true });
    await writeFile(target, file.contents, "utf8");
    options.logger.info(`wrote lunora/${file.path}`);

    return true;
};

/**
 * Narrow the introspected tables to what `--tables` asked for, reporting any name
 * that matched nothing — a typo would otherwise vanish silently and the run would
 * look successful while skipping the table the user actually wanted.
 */
const selectTables = (database: IntrospectedDatabase, options: IntrospectCommandOptions): IntrospectedDatabase["tables"] => {
    const requested = options.tables;

    if (requested === undefined || requested.length === 0) {
        return database.tables;
    }

    for (const name of requested) {
        if (!database.tables.some((table) => table.name === name)) {
            options.logger.warn(`--tables: no table named "${name}" exists in this schema — skipped.`);
        }
    }

    return database.tables.filter((table) => requested.includes(table.name));
};

/**
 * Fold an introspected database into a `schema.ts` that already exists, rather
 * than overwriting it. Returns `true` when the file was rewritten.
 */
const mergeExistingSchema = async (
    schemaPath: string,
    database: IntrospectedDatabase,
    dialect: SqlDialect,
    options: IntrospectCommandOptions,
): Promise<boolean> => {
    const merged = mergeIntoSchema(readFileSync(schemaPath, "utf8"), database, dialect);

    for (const warning of merged.warnings) {
        options.logger.warn(warning);
    }

    if (merged.text === undefined) {
        options.logger.info("lunora/schema.ts is already up to date with the database.");

        return false;
    }

    if (options.dryRun === true) {
        options.logger.info(`would merge ${String(merged.applied)} addition(s) into lunora/schema.ts`);

        return false;
    }

    await writeFile(schemaPath, merged.text, "utf8");
    options.logger.info(`merged ${String(merged.applied)} addition(s) into lunora/schema.ts`);

    return true;
};

/**
 * Read an existing database and scaffold `lunora/schema.ts` (plus per-table
 * procedure modules) from it. Read-only against the source database; never
 * overwrites an existing file without `--force`.
 */
const runIntrospectCommand = async (options: IntrospectCommandOptions): Promise<IntrospectCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    if (options.connection === undefined && (options.url === undefined || options.url === "")) {
        options.logger.error("`lunora introspect` needs a database URL: pass --url, or set DATABASE_URL.");

        return { code: 1, written: [] };
    }

    // With an injected connection there is no URL scheme to read the dialect from,
    // so it has to be stated. `readDatabase` branches on it, and defaulting silently
    // to Postgres would make the MySQL path unreachable through this seam.
    const dialect = options.connection === undefined ? dialectFromUrl(options.url as string) : (options.dialect ?? "postgres");
    // Drivers resolve from the project, not the CLI install, so `cwd` matters.
    const connection = options.connection ?? (await connect(options.url as string, dialect, options.schema, cwd));

    let database;

    try {
        database = await readDatabase(connection.execute, dialect, connection.schema);
    } finally {
        if (options.connection === undefined) {
            await connection.close();
        }
    }

    const selected = selectTables(database, options);

    if (selected.length === 0) {
        options.logger.error("no tables found to introspect — check --schema and --tables.");

        return { code: 1, written: [] };
    }

    const { files, warnings } = emitIntrospection(
        { ...database, tables: selected },
        { procedures: options.procedures !== false, serverImport: resolveServerImport(cwd) },
    );

    const directory = join(cwd, "lunora");
    const written: string[] = [];
    const schemaPath = join(directory, "schema.ts");

    // A schema already on disk is the developer's file, not ours. Rather than
    // refusing (or clobbering under --force), fold newly-discovered tables,
    // columns, and indexes into it as additive edits, preserving their formatting
    // and everything they've changed since the first run.
    const merging = existsSync(schemaPath) && options.force !== true;
    const remaining = merging ? files.filter((file) => file.path !== "schema.ts") : files;

    if (merging && (await mergeExistingSchema(schemaPath, { ...database, tables: selected }, dialect, options))) {
        written.push("schema.ts");
    }

    for (const file of remaining) {
        // Sequential on purpose: the log lines are the command's progress output
        // and interleaving them would make the report unreadable.
        // eslint-disable-next-line no-await-in-loop -- ordered console output
        if (await writeEmittedFile(file, directory, options)) {
            written.push(file.path);
        }
    }

    for (const warning of warnings) {
        options.logger.warn(warning);
    }

    options.logger.info(`introspected ${String(selected.length)} table(s) from ${dialect}. Review the generated files before running \`lunora dev\`.`);

    return { code: 0, written };
};

/** `lunora introspect` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<IntrospectOptions> = defineHandler<IntrospectOptions>(async ({ cwd, logger, options }) => {
    const result = await runIntrospectCommand({
        cwd,
        dryRun: options.dryRun === true,
        force: options.force === true,
        logger,
        procedures: options.procedures !== false,
        schema: options.schema,
        tables: options.tables === undefined ? undefined : options.tables.split(",").map((name) => name.trim()),
        url: options.url ?? process.env.DATABASE_URL,
    });

    return { code: result.code };
});

export { execute, resolveServerImport, runIntrospectCommand };
export type { IntrospectCommandOptions, IntrospectCommandResult };
