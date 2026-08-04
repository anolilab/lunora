import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SchemaIR } from "@lunora/codegen";
import { discoverSchema } from "@lunora/codegen";
import type { LinkedProject } from "@lunora/config";
import { readLinkedProject } from "@lunora/config";
import { findWranglerFile } from "@lunora/config/cloudflare";
import { parse as parseJsonc } from "jsonc-parser";
import { Project } from "ts-morph";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { InfoOptions } from "./index";

interface InfoCommandOptions {
    cwd?: string;
    json?: boolean;
    logger: Logger;
}

interface LunoraPackageInfo {
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

interface InfoSnapshot {
    /** The `.lunora/project.json` link, when this checkout is linked. */
    link: LinkedProject | undefined;
    lunoraPackages: ReadonlyArray<LunoraPackageInfo>;
    projectRoot: string;
    schema: SchemaSummary | undefined;
    schemaError: string | undefined;
    wrangler: WranglerSummary | undefined;
    wranglerPath: string | undefined;
}

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

const collectLunoraPackages = (projectRoot: string): ReadonlyArray<LunoraPackageInfo> => {
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
            if (!name.startsWith("@lunora/")) {
                continue;
            }

            if (typeof version === "string" && !seen.has(name)) {
                seen.set(name, version);
            }
        }
    }

    return [...seen.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, version]) => {
            return { name, version };
        });
};

const collectInfo = (projectRoot: string): InfoSnapshot => {
    const lunoraPackages = collectLunoraPackages(projectRoot);
    const wranglerPath = findWranglerFile(projectRoot);
    let wrangler: WranglerSummary | undefined;

    if (wranglerPath) {
        try {
            wrangler = summariseWrangler(parseJsonc(readFileSync(wranglerPath, "utf8")));
        } catch {
            wrangler = undefined;
        }
    }

    const schemaPath = join(projectRoot, "lunora", "schema.ts");
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
        link: readLinkedProject(projectRoot),
        lunoraPackages,
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
    logger.info("@lunora/* packages:");

    if (snapshot.lunoraPackages.length === 0) {
        logger.info("  (none found in package.json)");
    } else {
        for (const pkg of snapshot.lunoraPackages) {
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

    if (snapshot.link) {
        logger.info(`link: ${snapshot.link.workerName ?? "(unnamed)"} -> ${snapshot.link.workerUrl ?? "<no url>"}`);

        if (snapshot.link.env !== undefined) {
            logger.info(`  env: ${snapshot.link.env}`);
        }
    } else {
        logger.info("link: (not linked — run `lunora link --url <https://your-worker>`)");
    }

    logger.info("");

    if (snapshot.schemaError !== undefined) {
        logger.warn(`schema: parse error — ${snapshot.schemaError}`);
    } else if (snapshot.schema) {
        logger.info(`schema: ${String(snapshot.schema.tables.length)} table(s), ${String(snapshot.schema.vectorIndexes)} vector index(es)`);

        for (const table of snapshot.schema.tables) {
            logger.info(`  ${table.name}  [${table.shard}, ${String(table.indexes)} index(es)]`);
        }
    } else {
        logger.info("schema: (no lunora/schema.ts)");
    }
};

interface InfoCommandResult {
    code: number;
    snapshot: InfoSnapshot;
}

const runInfoCommand = (options: InfoCommandOptions): InfoCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const snapshot = collectInfo(cwd);

    if (options.json) {
        // Write straight to stdout so `lunora info --json | jq` works — Pail
        // prefixes (level + timestamps) would break the parser.
        process.stdout.write(`${JSON.stringify(snapshot, undefined, 2)}\n`);
    } else {
        renderText(snapshot, options.logger);
    }

    return { code: 0, snapshot };
};

/** `lunora info` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<InfoOptions> = defineHandler<InfoOptions>(({ cwd, logger, options }) =>
    runInfoCommand({ cwd, json: options.json === true, logger }),
);

export { execute };
export type { InfoCommandOptions, InfoCommandResult, InfoSnapshot };
export { collectInfo, runInfoCommand };
