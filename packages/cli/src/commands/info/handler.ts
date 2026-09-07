import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SchemaIR } from "@lunora/codegen";
import { discoverSchema } from "@lunora/codegen";
import type { LinkedProject } from "@lunora/config";
import { readLinkedProject } from "@lunora/config";
import { findWranglerFile } from "@lunora/config/cloudflare";
import { parse as parseJsonc } from "jsonc-parser";
import { Project } from "ts-morph";

import { deriveBindingManifest, writeBindingManifestFile } from "../../util/binding-manifest-file";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { InfoOptions } from "./index";

interface InfoCommandOptions {
    /** Report only the binding manifest — what this Worker needs provisioned. */
    bindings?: boolean;
    cwd?: string;
    json?: boolean;
    logger: Logger;
    /** With {@link InfoCommandOptions.bindings}: write the manifest here instead of stdout. */
    out?: string;
}

interface LunoraPackageInfo {
    name: string;
    version: string;
}

interface WranglerSummary {
    /**
     * Every binding the config declares, as `type:name`.
     *
     * Derived by the same function `lunora bindings` and `--emit-bindings` use.
     * This used to hand-roll its own read of three sections — d1, durable
     * objects, vectorize — so a project with R2, KV, queues, AI or any of the
     * other nine types was told it had none of them. A summary that silently
     * omits two thirds of the answer is worse than no summary.
     */
    bindings: ReadonlyArray<string>;
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

const summariseWrangler = (raw: unknown, projectRoot: string): WranglerSummary => {
    const { manifest } = deriveBindingManifest(projectRoot);

    return {
        bindings: (manifest?.bindings ?? []).map((requirement) => `${requirement.type}:${requirement.binding}`),
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
            wrangler = summariseWrangler(parseJsonc(readFileSync(wranglerPath, "utf8")), projectRoot);
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
        logger.info(`  bindings:           ${snapshot.wrangler.bindings.join(", ") || "<none>"}`);
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

/**
 * `--bindings`: what this Worker needs provisioned, and nothing else.
 *
 * The manifest is a pure function of the project, so answering it must not
 * require starting a dev server or producing a bundle — a supervisor planning a
 * multi-worker graph wants it before it starts anything. `build --emit-bindings`
 * and `lunora dev` write the same document from the same derivation, so a
 * deployer and a task runner cannot be told different things.
 */
const renderBindings = (options: { cwd: string; json: boolean; logger: Logger; out?: string }): { code: number } => {
    const { cwd, json, logger, out } = options;

    // `--out` goes through the SAME writer `build --emit-bindings` and `lunora dev`
    // use rather than re-deriving and re-serialising here. The hand-rolled copy
    // returned before the under-provisioning warning both siblings emit, so the
    // one caller most likely to be a machine — an IaC program consuming the
    // manifest — was the only one never told which wrangler sections it does not
    // model.
    if (out !== undefined) {
        const { error } = writeBindingManifestFile({ destination: out, logger, projectRoot: cwd });

        if (error !== undefined) {
            logger.error(error);

            return { code: 1 };
        }

        return { code: 0 };
    }

    const { error, manifest } = deriveBindingManifest(cwd);

    if (manifest === undefined) {
        // "No bindings" and "I could not tell" must not look the same: a deployer
        // acts on the first by provisioning nothing.
        logger.error(error ?? "could not derive the binding manifest");

        return { code: 1 };
    }

    if (json) {
        // Straight to stdout so `| jq` works — Pail prefixes would break it.
        process.stdout.write(`${JSON.stringify(manifest, undefined, 2)}\n`);

        return { code: 0 };
    }

    if (manifest.bindings.length === 0) {
        logger.info("No bindings declared.");
    } else {
        const width = Math.max(...manifest.bindings.map((requirement) => requirement.type.length));

        logger.info(`${String(manifest.bindings.length)} binding(s):`);

        for (const requirement of manifest.bindings) {
            const detail = [requirement.resource, requirement.className, requirement.resourceId].filter((part) => part !== undefined).join(" ");

            logger.info(`  ${requirement.type.padEnd(width)}  ${requirement.binding}${detail === "" ? "" : `  ${detail}`}`);
        }
    }

    if (manifest.crons.length > 0) {
        logger.info(`${String(manifest.crons.length)} cron trigger(s): ${manifest.crons.join(", ")}`);
    }

    if (manifest.vars.length > 0) {
        // Names only. The manifest never carries values, which is what lets
        // `lunora dev` write the same document into a working tree unasked.
        logger.info(`${String(manifest.vars.length)} var(s): ${manifest.vars.join(", ")}`);
    }

    if (manifest.unknown.length > 0) {
        logger.warn(`not modelled by the manifest: ${manifest.unknown.join(", ")} — anything they bind must be provisioned by hand.`);
    }

    return { code: 0 };
};

interface InfoCommandResult {
    code: number;
    /** Absent in `--bindings` mode, which answers a narrower question than the snapshot. */
    snapshot: InfoSnapshot | undefined;
}

const runInfoCommand = (options: InfoCommandOptions): InfoCommandResult => {
    const cwd = options.cwd ?? process.cwd();

    // `--bindings` narrows this command to the one question a MACHINE asks: what
    // does this Worker need provisioned. Same document `--emit-bindings` writes
    // and `lunora dev` drops next to its state record, from the same derivation,
    // so a deployer and a task runner cannot be told different things.
    if (options.bindings === true) {
        return { ...renderBindings({ cwd, json: options.json === true, logger: options.logger, out: options.out }), snapshot: undefined };
    }

    if (options.out !== undefined) {
        options.logger.error("--out only applies with --bindings; the full info snapshot prints to stdout under --json.");

        return { code: 1, snapshot: undefined };
    }

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
    runInfoCommand({ bindings: options.bindings === true, cwd, json: options.json === true, logger, out: options.out }),
);

export { execute };
export type { InfoCommandOptions, InfoCommandResult, InfoSnapshot };
export { collectInfo, runInfoCommand };
