import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverSchema, type SchemaIR } from "@cirrus/codegen";
import { parse as parseJsonc } from "jsonc-parser";
import { Project } from "ts-morph";

import type { Logger } from "../util/logger.js";

export interface InfoCommandOptions {
    cwd?: string;
    json?: boolean;
    logger: Logger;
}

interface CirrusPackageInfo {
    name: string;
    version: string;
}

interface WranglerSummary {
    bindings: {
        d1: ReadonlyArray<string>;
        durableObjects: ReadonlyArray<string>;
        vectorize: ReadonlyArray<string>;
    };
    compatibilityDate: string | undefined;
    compatibilityFlags: ReadonlyArray<string>;
    main: string | undefined;
    name: string | undefined;
}

interface SchemaSummary {
    tables: ReadonlyArray<{
        indexes: number;
        name: string;
        shard: string;
    }>;
    vectorIndexes: number;
}

export interface InfoSnapshot {
    cirrusPackages: ReadonlyArray<CirrusPackageInfo>;
    projectRoot: string;
    schema: SchemaSummary | undefined;
    schemaError: string | undefined;
    wrangler: WranglerSummary | undefined;
    wranglerPath: string | undefined;
}

const findWranglerFile = (projectRoot: string): string | undefined => {
    for (const candidate of ["wrangler.jsonc", "wrangler.json"]) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

const stringField = (record: unknown, key: string): string | undefined => {
    if (record === null || typeof record !== "object") {
        return undefined;
    }

    const value = (record as Record<string, unknown>)[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

const arrayField = (record: unknown, key: string): ReadonlyArray<unknown> => {
    if (record === null || typeof record !== "object") {
        return [];
    }

    const value = (record as Record<string, unknown>)[key];

    return Array.isArray(value) ? value : [];
};

const summariseWrangler = (raw: unknown): WranglerSummary => {
    const durableObjectBindings = arrayField((raw as Record<string, unknown>).durable_objects ?? {}, "bindings");
    const d1 = arrayField(raw, "d1_databases");
    const vectorize = arrayField(raw, "vectorize");

    return {
        bindings: {
            d1: d1.map((entry) => stringField(entry, "binding") ?? "<unnamed>"),
            durableObjects: durableObjectBindings.map((entry) => stringField(entry, "name") ?? "<unnamed>"),
            vectorize: vectorize.map((entry) => stringField(entry, "binding") ?? "<unnamed>"),
        },
        compatibilityDate: stringField(raw, "compatibility_date"),
        compatibilityFlags: arrayField(raw, "compatibility_flags").filter((entry): entry is string => typeof entry === "string"),
        main: stringField(raw, "main"),
        name: stringField(raw, "name"),
    };
};

const summariseSchema = (schema: SchemaIR): SchemaSummary => {
    return {
        tables: schema.tables.map((table) => {
            let shard = "root";

            if (table.shardMode === "global") {
                shard = "global";
            } else if (typeof table.shardMode === "object") {
                shard = `shardBy(${table.shardMode.field})`;
            }

            return {
                indexes: table.indexes.length,
                name: table.name,
                shard,
            };
        }),
        vectorIndexes: schema.vectorIndexes.length,
    };
};

const collectCirrusPackages = (projectRoot: string): ReadonlyArray<CirrusPackageInfo> => {
    const pkgPath = join(projectRoot, "package.json");

    if (!existsSync(pkgPath)) {
        return [];
    }

    let pkg: unknown;

    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
        return [];
    }

    if (pkg === null || typeof pkg !== "object") {
        return [];
    }

    const sections: ReadonlyArray<string> = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const seen = new Map<string, string>();

    for (const section of sections) {
        const block = (pkg as Record<string, unknown>)[section];

        if (block === null || typeof block !== "object") {
            continue;
        }

        for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
            if (!name.startsWith("@cirrus/")) {
                continue;
            }

            if (typeof version === "string" && !seen.has(name)) {
                seen.set(name, version);
            }
        }
    }

    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
};

export const collectInfo = (projectRoot: string): InfoSnapshot => {
    const cirrusPackages = collectCirrusPackages(projectRoot);
    const wranglerPath = findWranglerFile(projectRoot);
    let wrangler: WranglerSummary | undefined;

    if (wranglerPath) {
        try {
            wrangler = summariseWrangler(parseJsonc(readFileSync(wranglerPath, "utf8")));
        } catch {
            wrangler = undefined;
        }
    }

    const schemaPath = join(projectRoot, "cirrus", "schema.ts");
    let schema: SchemaSummary | undefined;
    let schemaError: string | undefined;

    if (existsSync(schemaPath)) {
        try {
            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

            schema = summariseSchema(discoverSchema(project, schemaPath));
        } catch (error: unknown) {
            schemaError = error instanceof Error ? error.message : String(error);
        }
    }

    return {
        cirrusPackages,
        projectRoot,
        schema,
        schemaError,
        wrangler,
        wranglerPath,
    };
};

const renderText = (snapshot: InfoSnapshot, logger: Logger): void => {
    logger.info(`project: ${snapshot.projectRoot}`);

    logger.info("");
    logger.info("@cirrus/* packages:");

    if (snapshot.cirrusPackages.length === 0) {
        logger.info("  (none found in package.json)");
    } else {
        for (const pkg of snapshot.cirrusPackages) {
            logger.info(`  ${pkg.name}@${pkg.version}`);
        }
    }

    logger.info("");

    if (snapshot.wrangler) {
        logger.info(`wrangler: ${snapshot.wranglerPath ?? ""}`);
        logger.info(`  name:               ${snapshot.wrangler.name ?? "<unset>"}`);
        logger.info(`  main:               ${snapshot.wrangler.main ?? "<unset>"}`);
        logger.info(`  compatibility_date: ${snapshot.wrangler.compatibilityDate ?? "<unset>"}`);
        logger.info(`  compatibility_flags: ${snapshot.wrangler.compatibilityFlags.join(", ") || "<none>"}`);
        logger.info(`  durable objects:    ${snapshot.wrangler.bindings.durableObjects.join(", ") || "<none>"}`);
        logger.info(`  d1 databases:       ${snapshot.wrangler.bindings.d1.join(", ") || "<none>"}`);
        logger.info(`  vectorize indexes:  ${snapshot.wrangler.bindings.vectorize.join(", ") || "<none>"}`);
    } else {
        logger.info("wrangler: (not found)");
    }

    logger.info("");

    if (snapshot.schemaError !== undefined) {
        logger.warn(`schema: parse error — ${snapshot.schemaError}`);
    } else if (snapshot.schema) {
        logger.info(`schema: ${snapshot.schema.tables.length} table(s), ${snapshot.schema.vectorIndexes} vector index(es)`);

        for (const table of snapshot.schema.tables) {
            logger.info(`  ${table.name}  [${table.shard}, ${table.indexes} index(es)]`);
        }
    } else {
        logger.info("schema: (no cirrus/schema.ts)");
    }
};

export interface InfoCommandResult {
    code: number;
    snapshot: InfoSnapshot;
}

export const runInfoCommand = (options: InfoCommandOptions): InfoCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const snapshot = collectInfo(cwd);

    if (options.json) {
        // Write straight to stdout so `cirrus info --json | jq` works — Pail
        // prefixes (level + timestamps) would break the parser.
        process.stdout.write(`${JSON.stringify(snapshot, undefined, 2)}\n`);
    } else {
        renderText(snapshot, options.logger);
    }

    return { code: 0, snapshot };
};
