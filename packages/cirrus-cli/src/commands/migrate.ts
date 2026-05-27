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

import { discoverSchema } from "@cirrus/codegen";
import { join } from "@visulima/path";
import { Project } from "ts-morph";

import type { Logger } from "../util/logger.js";
import type { SchemaSnapshot } from "../util/migrationDiff.js";
import { diffSnapshots, renderMigrationFile } from "../util/migrationDiff.js";
import { schemaIrToSnapshot } from "../util/schemaSnapshot.js";

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
    /** Absolute path to the migration file (empty string when nothing was written). */
    migrationFile: string;
    /** Whether the diff was empty (no changes detected). */
    empty: boolean;
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
        options.logger.error(`schema not found: ${schemaPath} — run \`cirrus new table <name>\` to create one`);

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
        options.logger.warn(
            `${diff.unsupported.length} unsupported diff(s) — see the comment block in ${filename} and write the SQL manually`,
        );
    }

    return { code: 0, empty: false, migrationFile };
};
