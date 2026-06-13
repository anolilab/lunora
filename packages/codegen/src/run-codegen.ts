import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Finding } from "@cirrus/advisor";
import { Project } from "ts-morph";

import { lintSchema } from "./advisor";
import discoverAiUsage from "./discover-ai-usage";
import discoverAuthApiCalls from "./discover-authapi-calls";
import { discoverContainers } from "./discover-containers";
import discoverCrons from "./discover-crons";
import { discoverFunctions, listCirrusSourceFiles } from "./discover-functions";
import discoverHttpRoutes from "./discover-http-routes";
import discoverInserts from "./discover-inserts";
import discoverMigrations from "./discover-migrations";
import discoverQueries from "./discover-queries";
import discoverRlsProcedures, { discoverRlsMetadata } from "./discover-rls-procedures";
import discoverSchema from "./discover-schema";
import discoverStorageRulesMetadata from "./discover-storage-rules";
import { emitApi, emitContainers, emitCrons, emitDataModel, emitDrizzleSchema, emitFunctions, emitServer, emitShard, emitVectors, emitWranglerCronTriggers } from "./emit";
import type { ContainerIR } from "./ir";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";
import type { SchemaSnapshot } from "./schema-drift";
import { buildSchemaSnapshot, serializeSchemaSnapshot } from "./schema-drift";

/**
 * Committed, tracked baseline file holding the blessed structural schema
 * snapshot the pre-deploy drift gate diffs against. Lives in `cirrus/` (NOT the
 * gitignored `_generated/`) so it is committed alongside `schema.ts`. Leading
 * dot keeps it tucked away next to the schema it describes.
 */
const SCHEMA_SNAPSHOT_FILENAME = ".cirrus-schema.json";

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
 * Normalise a path to POSIX (forward-slash) separators. ts-morph's
 * `SourceFile.getFilePath()` always returns forward slashes regardless of
 * platform, so any path compared against it must be normalised first or the
 * comparison silently fails on Windows.
 */
const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

/**
 * Construct the ts-morph `Project` codegen discovers over. Prefers the user's
 * `tsconfig.json` (when one is found walking up from `cirrusDirectory`) so
 * cross-file type resolution and path aliases work; falls back to an isolated
 * project otherwise. This is the exact construction {@link runCodegen} uses
 * when no `project` is injected — exported so a long-lived caller (the Vite
 * dev-loop) can build one once and reuse it across runs via
 * {@link refreshCodegenProject} instead of re-parsing the user's whole TS
 * program on every save.
 */
export const createCodegenProject = (cirrusDirectory: string): Project => {
    const tsconfigPath = findTsconfig(cirrusDirectory);

    return tsconfigPath
        ? new Project({ skipAddingFilesFromTsConfig: false, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false })
        : new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
};

/**
 * Synchronise a reused {@link createCodegenProject} Project with the current
 * on-disk state of `cirrusDirectory`, so the next {@link runCodegen} sees the
 * same files a freshly-constructed Project would — without re-parsing the whole
 * TS program. Adds any on-disk source file the Project doesn't yet have, and
 * `refreshFromFileSystemSync()`es the ones it does (picking up edits); then
 * removes Project source files under `cirrusDirectory` that no longer exist on
 * disk (the classic stale-deleted-file cache bug).
 *
 * Files outside `cirrusDirectory` (e.g. those pulled in by the user's tsconfig)
 * are left untouched — they back type resolution and rarely change in the
 * dev-loop; a tsconfig change invalidates the whole cached Project upstream.
 */
export const refreshCodegenProject = (project: Project, cirrusDirectory: string): void => {
    // The exact set discovery reads: every non-`schema.ts` source file (the
    // canonical `listCirrusSourceFiles`, shared with function/migration
    // discovery) plus `schema.ts`, which `discoverSchema` loads separately.
    // Reusing the canonical walker keeps the reused Project's file set in
    // lockstep with a freshly-constructed one instead of forking the rules.
    const diskPaths = listCirrusSourceFiles(cirrusDirectory);
    const schemaPath = join(cirrusDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        diskPaths.push(schemaPath);
    }

    for (const path of diskPaths) {
        const existing = project.getSourceFile(path);

        if (existing === undefined) {
            project.addSourceFileAtPath(path);
        } else {
            existing.refreshFromFileSystemSync();
        }
    }

    // Drop source files under the cirrus directory that vanished from disk, so a
    // deleted query/table never lingers in the reused Project's discovery set.
    // `getFilePath()` is always POSIX while `diskPaths` carry the OS separator —
    // normalise both sides or the removal silently never fires on Windows.
    const onDisk = new Set(diskPaths.map((path) => toPosixPath(path)));
    const cirrusRoot = toPosixPath(cirrusDirectory);
    const cirrusPrefix = `${cirrusRoot}/`;

    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();

        if ((filePath === cirrusRoot || filePath.startsWith(cirrusPrefix)) && !onDisk.has(filePath)) {
            project.removeSourceFile(sourceFile);
        }
    }
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

    // Reuse an injected Project (the caller owns refreshing its source files
    // from disk — see refreshCodegenProject) when provided; otherwise build one
    // exactly as createCodegenProject would.
    const project = options.project ?? createCodegenProject(cirrusDirectory);

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
    // Containers declared via `defineContainer` exports in `cirrus/containers.ts`.
    // Gates `_generated/containers.ts` (the Container DO classes) + the typed
    // `ctx.containers` on ActionCtx, feeds the config layer's wrangler
    // reconciliation (containers[] + CONTAINER_* DO bindings + migrations), and
    // the `container_*` advisor lints below.
    const containers = discoverContainers(project, cirrusDirectory);

    const advisories =
        options.lint === false
            ? []
            : lintSchema(
                  schema,
                  discoverQueries(project, cirrusDirectory),
                  discoverInserts(project, cirrusDirectory),
                  discoverAuthApiCalls(project, cirrusDirectory),
                  discoverRlsProcedures(project, cirrusDirectory),
                  containers,
              );

    // Read-only RLS metadata (policies + roles) the studio's RLS inspector lists,
    // emitted into the generated ShardDO's `rlsMetadata()` override. Statically
    // discovered from every `.use(rls(...))` chain — never the `when` predicate.
    const rlsMetadata = discoverRlsMetadata(project, cirrusDirectory);

    // Read-only storage access-rule metadata (the studio's access-rules view),
    // statically discovered from every `.use(storageRules(...))` chain and
    // emitted into the generated ShardDO's `storageRulesMetadata()` override.
    const storageRulesMetadata = discoverStorageRulesMetadata(project, cirrusDirectory);

    // Whether any function uses Workers AI (imports `@cirrus/ai` or reads
    // `ctx.ai`). Gates wiring `ctx.ai` into the generated ShardDO + the typed
    // ActionCtx — so non-AI projects never import the AI SDK into their worker.
    const hasAi = discoverAiUsage(project, cirrusDirectory);

    const dataModelContent = emitDataModel(schema);
    const apiContent = emitApi(functions);
    const serverContent = emitServer(
        hasAi,
        schema,
        storageRulesMetadata.rules.map((rule) => rule.bucket),
        containers,
    );
    const functionsContent = emitFunctions(functions, migrations);
    const shardContent = emitShard(schema, advisories, rlsMetadata, hasAi, storageRulesMetadata, containers);
    const containersContent = emitContainers(containers);
    const cronsContent = emitCrons(crons);
    const vectorsContent = emitVectors(schema.vectorIndexes);
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

    // Structural schema snapshot for the pre-deploy drift gate. Built from the
    // discovered schema + the declared migration ids; the CLI gate diffs the
    // CURRENT snapshot against the committed baseline. Always computed (cheap,
    // pure) and returned in `CodegenResult`; the baseline file is (re-)blessed
    // only when it is absent (first capture) or `updateSchemaBaseline` is set —
    // so a routine codegen run never silently moves the goalposts the gate
    // measures against.
    const schemaSnapshot = buildSchemaSnapshot(
        schema,
        migrations.map((migration) => migration.id),
    );
    const schemaSnapshotPath = join(cirrusDirectory, SCHEMA_SNAPSHOT_FILENAME);
    const schemaSnapshotExists = existsSync(schemaSnapshotPath);

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
        writeIfChanged(join(outputDirectory, "vectors.ts"), vectorsContent);
        writeIfChanged(join(outputDirectory, "drizzle.global.ts"), drizzleFiles.global);
        writeIfChanged(join(outputDirectory, "drizzle.shard.ts"), drizzleFiles.shard);

        // Only written when containers are declared — non-container projects
        // keep a clean `_generated/` (and never import `@cirrus/container`).
        if (containersContent !== "") {
            writeIfChanged(join(outputDirectory, "containers.ts"), containersContent);
        }

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

        // Bless the schema baseline on first capture (so a project gets a
        // committed snapshot the moment it runs codegen) or when explicitly
        // asked to refresh it. The CLI gate reads the existing baseline BEFORE
        // calling codegen, so re-blessing here never hides drift from that run.
        if (!schemaSnapshotExists || options.updateSchemaBaseline === true) {
            writeIfChanged(schemaSnapshotPath, serializeSchemaSnapshot(schemaSnapshot));
        }
    }

    return {
        advisories,
        containers,
        cronTriggers: emitWranglerCronTriggers(crons),
        generated: {
            api: apiContent,
            containers: containersContent,
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
            vectors: vectorsContent,
        },
        outputDirectory,
        schemaSnapshot,
        schemaSnapshotPath,
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

    /**
     * Reuse a previously-constructed ts-morph {@link Project} instead of building
     * a fresh one each run. The caller owns refreshing its source files from disk
     * (see {@link refreshCodegenProject}) — codegen does not re-read changed files
     * off an injected Project. Built via {@link createCodegenProject} when absent.
     * Used by the Vite dev-loop to avoid re-parsing the whole TS program on every
     * save; omit it (CLI one-shot path) to get the default fresh-Project behaviour.
     */
    project?: Project;

    /** Project root containing the `cirrus/` directory. */
    projectRoot: string;

    /**
     * Re-bless the committed schema-drift baseline (`cirrus/.cirrus-schema.json`)
     * with the current structural snapshot. The baseline is ALWAYS written on
     * first capture (when the file is absent); set this to overwrite an existing
     * one — e.g. after the developer has added the data migration that justifies
     * a breaking change. Ignored when `dryRun` is true.
     */
    updateSchemaBaseline?: boolean;
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
     * Containers discovered from `defineContainer` exports in
     * `cirrus/containers.ts` — the list the config layer reconciles into
     * wrangler's `containers[]`, `CONTAINER_*` Durable Object bindings, and
     * migration classes. Empty when the project declares no containers.
     */
    containers: ReadonlyArray<ContainerIR>;

    /**
     * Deduplicated cron schedules discovered from `cronJobs()` definitions —
     * the array the vite plugin reconciles into `wrangler.jsonc`'s
     * `triggers.crons`. Empty when the project declares no crons.
     */
    cronTriggers: ReadonlyArray<string>;
    generated: {
        api: string;
        /** Container DO classes (`_generated/containers.ts`); `""` (and not written) when no containers are declared. */
        containers: string;
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
        /** Static vector-index registry (`_generated/vectors.ts`) — `CIRRUS_VECTOR_INDEXES`. Empty array body when the schema declares none. */
        vectors: string;
    };
    outputDirectory: string;

    /**
     * The CURRENT structural schema snapshot computed this run (tables + field
     * kinds/optionality + indexes/relations/shard mode + declared migration ids).
     * The pre-deploy drift gate diffs this against the committed baseline read
     * from {@link CodegenResult.schemaSnapshotPath}. Always present, even on a
     * `dryRun`.
     */
    schemaSnapshot: SchemaSnapshot;

    /** Absolute path of the committed baseline file (`cirrus/.cirrus-schema.json`). */
    schemaSnapshotPath: string;
}

// Exports kept at end-of-file per the package's `import/exports-last` rule.
export { SCHEMA_SNAPSHOT_FILENAME };
