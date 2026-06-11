import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Finding } from "@cirrus/advisor";
import { Project } from "ts-morph";

import { lintSchema } from "./advisor";
import discoverAuthApiCalls from "./discover-authapi-calls";
import discoverCrons from "./discover-crons";
import { discoverFunctions } from "./discover-functions";
import discoverHttpRoutes from "./discover-http-routes";
import discoverInserts from "./discover-inserts";
import discoverMigrations from "./discover-migrations";
import discoverQueries from "./discover-queries";
import discoverRlsProcedures from "./discover-rls-procedures";
import discoverSchema from "./discover-schema";
import { emitApi, emitCrons, emitDataModel, emitDrizzleSchema, emitFunctions, emitServer, emitShard, emitWranglerCronTriggers } from "./emit";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";

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
    const httpRoutes = discoverHttpRoutes(project, cirrusDirectory);
    const migrations = discoverMigrations(project, cirrusDirectory);
    const crons = discoverCrons(project, cirrusDirectory);

    // Static advisories (unindexed FKs, redundant indexes, unknown index/relation
    // fields, filter-without-index, …). Cheap, derived from the schema + the
    // discovered query reads, and run here so a problem surfaces at codegen time
    // — before it ships. Opt out via `lint: false`. Presentation is the caller's
    // job: the result carries the findings and each caller surfaces them through
    // its own channel (the CLI logger, the vite overlay, the studio Advisors
    // table) rather than this library printing.
    const advisories =
        options.lint === false
            ? []
            : lintSchema(
                  schema,
                  discoverQueries(project, cirrusDirectory),
                  discoverInserts(project, cirrusDirectory),
                  discoverAuthApiCalls(project, cirrusDirectory),
                  discoverRlsProcedures(project, cirrusDirectory),
              );

    const dataModelContent = emitDataModel(schema);
    const apiContent = emitApi(functions);
    const serverContent = emitServer();
    const functionsContent = emitFunctions(functions, migrations);
    const shardContent = emitShard(schema, advisories);
    const cronsContent = emitCrons(crons);
    const drizzleFiles = emitDrizzleSchema(schema);

    // Which API spec(s) the run emits. Defaults to `"openapi"` so existing
    // projects (and the golden fixtures) keep writing only `openapi.json`.
    const apiSpec = options.apiSpec ?? "openapi";
    const wantsOpenApi = apiSpec === "openapi" || apiSpec === "both";
    const wantsOpenRpc = apiSpec === "openrpc" || apiSpec === "both";

    // Build each spec document once, then derive both artifacts from the same
    // object so the portable `.json` and the worker-importable `.ts` are
    // identical content and can never drift. Both are computed regardless of
    // `apiSpec` (cheap, pure) so `CodegenResult` can carry whichever the caller
    // asked for; only the requested file(s) are written.
    const openApiDocument = buildOpenApiDocument({ functions, httpRoutes });
    const openRpcDocument = buildOpenRpcDocument({ functions });

    const openApiContent = `${JSON.stringify(openApiDocument, undefined, 2)}\n`;
    const openRpcContent = `${JSON.stringify(openRpcDocument, undefined, 2)}\n`;
    const openApiModuleContent = emitOpenApiModule(openApiDocument);
    const openRpcModuleContent = emitOpenRpcModule(openRpcDocument);

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

        if (wantsOpenApi) {
            // The `.json` is the portable artifact for external tooling; the
            // `.ts` (same document, inlined) is what the worker imports and
            // passes to `createWorker({ openApiSpec })`. Both are gated on the
            // same `apiSpec` choice so they regenerate together.
            writeIfChanged(join(outputDirectory, "openapi.json"), openApiContent);
            writeIfChanged(join(outputDirectory, "openapi.ts"), openApiModuleContent);
        }

        if (wantsOpenRpc) {
            writeIfChanged(join(outputDirectory, "openrpc.json"), openRpcContent);
            writeIfChanged(join(outputDirectory, "openrpc.ts"), openRpcModuleContent);
        }
    }

    return {
        advisories,
        cronTriggers: emitWranglerCronTriggers(crons),
        generated: {
            api: apiContent,
            crons: cronsContent,
            dataModel: dataModelContent,
            drizzleGlobal: drizzleFiles.global,
            drizzleShard: drizzleFiles.shard,
            functions: functionsContent,
            openApi: openApiContent,
            openApiModule: openApiModuleContent,
            openRpc: openRpcContent,
            openRpcModule: openRpcModuleContent,
            server: serverContent,
            shard: shardContent,
        },
        outputDirectory,
    };
};

export interface CodegenOptions {
    /**
     * Which machine-readable API spec(s) to emit into `_generated/`.
     *
     * `"openapi"` (the default) writes only `openapi.json` (OpenAPI 3.1; covers
     * both the RPC functions and `httpRouter()` REST routes). `"openrpc"` writes
     * only `openrpc.json` (OpenRPC 1.x; the RPC functions only — OpenRPC cannot
     * represent REST routes). `"both"` writes both files; `"none"` writes neither.
     *
     * Regardless of the choice, `CodegenResult.generated.openApi` and `.openRpc`
     * always carry the rendered string (computation is cheap and pure); only the
     * on-disk write is gated by this option.
     */
    apiSpec?: "both" | "none" | "openapi" | "openrpc";

    /** Override the cirrus subdirectory name. Defaults to `"cirrus"`. */
    cirrusDirectory?: string;

    /**
     * When true, run discovery + emit (so any schema/function parse error
     * surfaces) but skip writing files to `_generated/`. The returned
     * `outputDirectory` is still the path that *would* have been written.
     */
    dryRun?: boolean;

    /**
     * Run the static schema advisor (unindexed FKs, …) during codegen.
     * Defaults to `true`. When `false`, `CodegenResult.advisories` is empty.
     * Computed regardless of `dryRun`; codegen never prints them — see
     * {@link CodegenResult.advisories}.
     */
    lint?: boolean;
    /** Project root containing the `cirrus/` directory. */
    projectRoot: string;
}

export interface CodegenResult {
    /**
     * Static schema advisor findings (e.g. unindexed foreign keys) produced
     * this run. Empty when `lint` is `false` or the schema is clean. Codegen
     * does not print these itself — each caller presents them through its own
     * channel (the CLI logger, the vite overlay, the studio Advisors table).
     * `formatAdvisories` is exported for a plain multi-line rendering.
     */
    advisories: ReadonlyArray<Finding>;

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
        /** OpenAPI 3.1.0 document (`_generated/openapi.json`), pretty-printed JSON. */
        openApi: string;

        /**
         * OpenAPI document as an importable TS module (`_generated/openapi.ts`) —
         * `export const openApiSpec`, the worker imports it for
         * `createWorker({ openApiSpec })`. Same document as `openApi`. Written
         * alongside `openapi.json` whenever `apiSpec` includes `openapi`.
         */
        openApiModule: string;
        /** OpenRPC 1.x document (`_generated/openrpc.json`), pretty-printed JSON. Always computed; written only when `apiSpec` includes `openrpc`. */
        openRpc: string;

        /**
         * OpenRPC document as an importable TS module (`_generated/openrpc.ts`) —
         * `export const openRpcSpec`, for `createWorker({ openRpcSpec })`. Same
         * document as `openRpc`. Written alongside `openrpc.json` whenever
         * `apiSpec` includes `openrpc`.
         */
        openRpcModule: string;
        server: string;
        shard: string;
    };
    outputDirectory: string;
}
