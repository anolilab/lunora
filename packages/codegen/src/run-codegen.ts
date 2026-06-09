import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";

import discoverCrons from "./discover-crons";
import { discoverFunctions } from "./discover-functions";
import discoverMigrations from "./discover-migrations";
import discoverSchema from "./discover-schema";
import { emitApi, emitCrons, emitDataModel, emitDrizzleSchema, emitFunctions, emitServer, emitShard, emitWranglerCronTriggers } from "./emit";

const writeIfChanged = (filePath: string, content: string): void => {
    // Avoid spurious writes (and downstream HMR reloads) when the rendered
    // content is identical to what's on disk.
    if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf8");

        if (existing === content) {
            return;
        }
    }

    writeFileSync(filePath, content, "utf8");
};

/**
 * Walk up from `startPath` until we find a `tsconfig.json` or hit the file
 * system root. Returns the absolute path to the tsconfig, or `undefined`.
 */
const findTsconfig = (startPath: string): string | undefined => {
    let directory = existsSync(startPath) ? startPath : dirname(startPath);

    while (directory && directory !== dirname(directory)) {
        const candidate = join(directory, "tsconfig.json");

        if (existsSync(candidate)) {
            return candidate;
        }

        directory = dirname(directory);
    }

    return undefined;
};

/**
 * Top-level codegen entry. Parses `&lt;projectRoot>/cirrus/schema.ts` and every
 * function file under `&lt;projectRoot>/cirrus/`, then writes
 * `_generated/{api,server,dataModel}.ts` next to them.
 */
export const runCodegen = (options: CodegenOptions): CodegenResult => {
    const cirrusDirectory = join(options.projectRoot, options.cirrusDirectory ?? "cirrus");
    const schemaPath = join(cirrusDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        throw new Error(`schema.ts not found at ${schemaPath}`);
    }

    // Prefer the user's tsconfig (when present) so cross-file type resolution
    // and path aliases work. Fall back to an isolated project otherwise.
    const tsconfigPath = findTsconfig(cirrusDirectory);
    const project = tsconfigPath
        ? new Project({ skipAddingFilesFromTsConfig: false, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false })
        : new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    const schema = discoverSchema(project, schemaPath);
    const functions = discoverFunctions(project, cirrusDirectory);
    const migrations = discoverMigrations(project, cirrusDirectory);
    const crons = discoverCrons(project, cirrusDirectory);

    const dataModelContent = emitDataModel(schema);
    const apiContent = emitApi(functions);
    const serverContent = emitServer();
    const functionsContent = emitFunctions(functions, migrations);
    const shardContent = emitShard(schema);
    const cronsContent = emitCrons(crons);
    const drizzleFiles = emitDrizzleSchema(schema);

    const outputDirectory = join(cirrusDirectory, "_generated");

    if (!options.dryRun) {
        if (!existsSync(outputDirectory)) {
            mkdirSync(outputDirectory, { recursive: true });
        }

        writeIfChanged(join(outputDirectory, "dataModel.ts"), dataModelContent);
        writeIfChanged(join(outputDirectory, "api.ts"), apiContent);
        writeIfChanged(join(outputDirectory, "server.ts"), serverContent);
        writeIfChanged(join(outputDirectory, "functions.ts"), functionsContent);
        writeIfChanged(join(outputDirectory, "shard.ts"), shardContent);
        writeIfChanged(join(outputDirectory, "crons.ts"), cronsContent);
        writeIfChanged(join(outputDirectory, "drizzle.global.ts"), drizzleFiles.global);
        writeIfChanged(join(outputDirectory, "drizzle.shard.ts"), drizzleFiles.shard);
    }

    return {
        cronTriggers: emitWranglerCronTriggers(crons),
        generated: {
            api: apiContent,
            crons: cronsContent,
            dataModel: dataModelContent,
            drizzleGlobal: drizzleFiles.global,
            drizzleShard: drizzleFiles.shard,
            functions: functionsContent,
            server: serverContent,
            shard: shardContent,
        },
        outputDirectory,
    };
};

export interface CodegenOptions {
    /** Override the cirrus subdirectory name. Defaults to `"cirrus"`. */
    cirrusDirectory?: string;

    /**
     * When true, run discovery + emit (so any schema/function parse error
     * surfaces) but skip writing files to `_generated/`. The returned
     * `outputDirectory` is still the path that *would* have been written.
     */
    dryRun?: boolean;
    /** Project root containing the `cirrus/` directory. */
    projectRoot: string;
}

export interface CodegenResult {
    /**
     * Deduplicated cron schedules discovered from `cronJobs()` definitions —
     * the array the vite plugin reconciles into `wrangler.jsonc`'s
     * `triggers.crons`. Empty when the project declares no crons.
     */
    cronTriggers: ReadonlyArray<string>;
    generated: {
        api: string;
        crons: string;
        dataModel: string;
        drizzleGlobal: string;
        drizzleShard: string;
        functions: string;
        server: string;
        shard: string;
    };
    outputDirectory: string;
}
