import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Finding } from "@lunora/advisor";
import { Project } from "ts-morph";

import { lintSchema } from "./advisor";
import discoverAdminRoutes from "./discover-admin-routes";
import discoverArgumentValidators from "./discover-argument-validators";
import discoverAuthApiCalls from "./discover-authapi-calls";
import { discoverContainers } from "./discover-containers";
import discoverCrons from "./discover-crons";
import { buildStudioFeatures, discoverFeatureUsage } from "./discover-feature-usage";
import { discoverFunctions, listLunoraSourceFiles } from "./discover-functions";
import discoverHttpRoutes from "./discover-http-routes";
import discoverInserts from "./discover-inserts";
import discoverMaskProcedures, { discoverMaskMetadata } from "./discover-mask-procedures";
import discoverMigrations from "./discover-migrations";
import discoverNondeterministicCalls from "./discover-nondeterministic-calls";
import discoverPackageDependencies from "./discover-package-dependencies";
import discoverProcedureMiddleware from "./discover-procedure-middleware";
import discoverQueries from "./discover-queries";
import discoverRlsProcedures, { discoverRlsMetadata } from "./discover-rls-procedures";
import discoverSchema from "./discover-schema";
import discoverSecrets from "./discover-secrets";
import discoverSqlInterpolation from "./discover-sql-interpolation";
import discoverStorageRulesMetadata from "./discover-storage-rules";
import discoverWorkflowCalls from "./discover-workflow-calls";
import { discoverWorkflows } from "./discover-workflows";
import {
    buildStorageColumns,
    emitApi,
    emitContainers,
    emitCrons,
    emitDataModel,
    emitDrizzleSchema,
    emitFunctions,
    emitSeed,
    emitServer,
    emitShard,
    emitVectors,
    emitWorkflows,
    emitWranglerCronTriggers,
} from "./emit";
import { emitApp } from "./emit-app";
import type { ContainerIR, WorkflowIR } from "./ir";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";
import type { SchemaSnapshot } from "./schema-drift";
import { buildSchemaSnapshot, serializeSchemaSnapshot } from "./schema-drift";

/**
 * Committed, tracked baseline file holding the blessed structural schema
 * snapshot the pre-deploy drift gate diffs against. Lives in `lunora/` (NOT the
 * gitignored `_generated/`) so it is committed alongside `schema.ts`. Leading
 * dot keeps it tucked away next to the schema it describes.
 */
const SCHEMA_SNAPSHOT_FILENAME = ".lunora-schema.json";

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
 * Write a conditionally-emitted `_generated/` file: a no-op when `content` is
 * the empty string (the convention `emit*` helpers use to mean "not
 * applicable"), so the file is only created for projects that actually use the
 * feature. Keeps the per-feature gating out of `runCodegen`'s control flow.
 */
const writeIfPresent = (filePath: string, content: string): void => {
    if (content !== "") {
        writeIfChanged(filePath, content);
    }
};

/**
 * Read the `version` field from the `package.json` at `projectRoot`.
 *
 * Returns the version string when present and parseable, or `undefined` when
 * the manifest is absent, malformed, or carries no `version` field. The
 * `?? "0.0.0"` fallback in the spec emitters then applies, so a missing
 * package.json never breaks codegen.
 */
const readProjectVersion = (projectRoot: string): string | undefined => {
    const manifestPath = join(projectRoot, "package.json");

    if (!existsSync(manifestPath)) {
        return undefined;
    }

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

        return typeof manifest["version"] === "string" && manifest["version"] !== "" ? manifest["version"] : undefined;
    } catch {
        return undefined;
    }
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
 * `tsconfig.json` (when one is found walking up from `lunoraDirectory`) so
 * cross-file type resolution and path aliases work; falls back to an isolated
 * project otherwise. This is the exact construction {@link runCodegen} uses
 * when no `project` is injected — exported so a long-lived caller (the Vite
 * dev-loop) can build one once and reuse it across runs via
 * {@link refreshCodegenProject} instead of re-parsing the user's whole TS
 * program on every save.
 */
export const createCodegenProject = (lunoraDirectory: string): Project => {
    const tsconfigPath = findTsconfig(lunoraDirectory);

    return tsconfigPath
        ? new Project({ skipAddingFilesFromTsConfig: false, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false })
        : new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
};

/**
 * Synchronise a reused {@link createCodegenProject} Project with the current
 * on-disk state of `lunoraDirectory`, so the next {@link runCodegen} sees the
 * same files a freshly-constructed Project would — without re-parsing the whole
 * TS program. Adds any on-disk source file the Project doesn't yet have, and
 * `refreshFromFileSystemSync()`es the ones it does (picking up edits); then
 * removes Project source files under `lunoraDirectory` that no longer exist on
 * disk (the classic stale-deleted-file cache bug).
 *
 * Files outside `lunoraDirectory` (e.g. those pulled in by the user's tsconfig)
 * are left untouched — they back type resolution and rarely change in the
 * dev-loop; a tsconfig change invalidates the whole cached Project upstream.
 */
export const refreshCodegenProject = (project: Project, lunoraDirectory: string): void => {
    // The exact set discovery reads: every non-`schema.ts` source file (the
    // canonical `listLunoraSourceFiles`, shared with function/migration
    // discovery) plus `schema.ts`, which `discoverSchema` loads separately.
    // Reusing the canonical walker keeps the reused Project's file set in
    // lockstep with a freshly-constructed one instead of forking the rules.
    const diskPaths = listLunoraSourceFiles(lunoraDirectory);
    const schemaPath = join(lunoraDirectory, "schema.ts");

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

    // Drop source files under the lunora directory that vanished from disk, so a
    // deleted query/table never lingers in the reused Project's discovery set.
    // `getFilePath()` is always POSIX while `diskPaths` carry the OS separator —
    // normalise both sides or the removal silently never fires on Windows.
    const onDisk = new Set(diskPaths.map((path) => toPosixPath(path)));
    const lunoraRoot = toPosixPath(lunoraDirectory);
    const lunoraPrefix = `${lunoraRoot}/`;

    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();

        if ((filePath === lunoraRoot || filePath.startsWith(lunoraPrefix)) && !onDisk.has(filePath)) {
            project.removeSourceFile(sourceFile);
        }
    }
};

/**
 * Top-level codegen entry. Parses `&lt;projectRoot>/lunora/schema.ts` and every
 * function file under `&lt;projectRoot>/lunora/`, then writes
 * `_generated/{api,server,dataModel}.ts` next to them.
 */
export const runCodegen = (options: CodegenOptions): CodegenResult => {
    const lunoraDirectory = join(options.projectRoot, options.lunoraDirectory ?? "lunora");
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        throw new Error(`schema.ts not found at ${schemaPath}`);
    }

    // Reuse an injected Project (the caller owns refreshing its source files
    // from disk — see refreshCodegenProject) when provided; otherwise build one
    // exactly as createCodegenProject would.
    const project = options.project ?? createCodegenProject(lunoraDirectory);

    const schema = discoverSchema(project, schemaPath);
    const functions = discoverFunctions(project, lunoraDirectory);
    const httpRoutes = discoverHttpRoutes(project, lunoraDirectory);
    const migrations = discoverMigrations(project, lunoraDirectory);

    // Workflows declared via `defineWorkflow` exports in `lunora/workflows.ts`.
    // Discovered before crons so a `cronJobs()` registration can target a
    // workflow by its export name (the cron then starts a durable instance per
    // fire instead of dispatching a one-shot function).
    const workflows = discoverWorkflows(project, lunoraDirectory);
    const crons = discoverCrons(project, lunoraDirectory, workflows);

    // Static advisories (unindexed FKs, redundant indexes, unknown index/relation
    // fields, filter-without-index, …). Cheap, derived from the schema + the
    // discovered query reads, and run here so a problem surfaces at codegen time
    // — before it ships. Opt out via `lint: false`. Presentation is the caller's
    // job: the result carries the findings and each caller surfaces them through
    // its own channel (the CLI logger, the vite overlay, the studio Advisors
    // table) rather than this library printing.
    // Containers declared via `defineContainer` exports in `lunora/containers.ts`.
    // Gates `_generated/containers.ts` (the Container DO classes) + the typed
    // `ctx.containers` on ActionCtx, feeds the config layer's wrangler
    // reconciliation (containers[] + CONTAINER_* DO bindings + migrations), and
    // the `container_*` advisor lints below.
    const containers = discoverContainers(project, lunoraDirectory);

    // Workflows (`_generated/workflows.ts` — the WorkflowEntrypoint classes — the
    // typed `ctx.workflows` on Mutation/Action contexts, and the config layer's
    // wrangler reconciliation of the `workflows[]` array) are discovered above,
    // ahead of crons, so a cron may target one.

    const advisories =
        options.lint === false
            ? []
            : lintSchema(
                  schema,
                  discoverQueries(project, lunoraDirectory),
                  discoverInserts(project, lunoraDirectory),
                  discoverAuthApiCalls(project, lunoraDirectory),
                  discoverRlsProcedures(project, lunoraDirectory),
                  containers,
                  workflows,
                  discoverWorkflowCalls(project, lunoraDirectory),
                  discoverMaskProcedures(project, lunoraDirectory),
                  discoverNondeterministicCalls(project, lunoraDirectory),
                  discoverProcedureMiddleware(project, lunoraDirectory),
                  discoverArgumentValidators(project, lunoraDirectory),
                  discoverSecrets(project, lunoraDirectory),
                  discoverSqlInterpolation(project, lunoraDirectory),
                  discoverAdminRoutes(project, lunoraDirectory),
              );

    // Read-only RLS metadata (policies + roles) the studio's RLS inspector lists,
    // emitted into the generated ShardDO's `rlsMetadata()` override. Statically
    // discovered from every `.use(rls(...))` chain — never the `when` predicate.
    const rlsMetadata = discoverRlsMetadata(project, lunoraDirectory);

    // Read-only masking metadata (table + column + strategy) the studio's
    // data-browser mask toggle previews, emitted into the generated ShardDO's
    // `maskMetadata()` override. Statically discovered from every
    // `.use(mask(...))` chain — never the masking closure.
    const maskMetadata = discoverMaskMetadata(project, lunoraDirectory);

    // Read-only storage access-rule metadata (the studio's access-rules view),
    // statically discovered from every `.use(storageRules(...))` chain and
    // emitted into the generated ShardDO's `storageRulesMetadata()` override.
    const storageRulesMetadata = discoverStorageRulesMetadata(project, lunoraDirectory);

    // Single-pass code-usage detection for every optional, package-backed
    // feature: each flag is set when a `lunora/` source imports the feature's
    // `@lunora/*` package or reads its generated `ctx.*` helper. `ai` and
    // `payments` gate wiring the SDK into the generated ShardDO + the typed
    // ActionCtx — so a non-AI / non-payment project never imports those into its
    // worker; the rest additionally feed the studio nav gating below.
    const featureUsage = discoverFeatureUsage(project, lunoraDirectory);
    const hasAi = featureUsage.ai;
    const hasPayments = featureUsage.payments;
    // New Cloudflare-capability ctx augmentations (Plans 027/028/031/032/035/036).
    // These flip the emitted ctx type seam in `server.ts` (type-only dynamic
    // imports); the runtime ShardDO wiring lands with each capability's package.
    const hasKv = featureUsage.kv;
    const hasHyperdrive = featureUsage.hyperdrive;
    const hasBrowser = featureUsage.browser;
    const hasImages = featureUsage.images;
    const hasAnalytics = featureUsage.analytics;
    const hasPipelines = featureUsage.pipelines;

    // Which optional, package-backed features the studio should show a nav page
    // for. `buildStudioFeatures` OR's the code-usage flags with the schema/project
    // signals the `lunora/`-scoped scan can't see: storage columns + access rules,
    // declared crons, vector indexes, and — crucially for packages wired only in
    // the worker entry (e.g. `@lunora/mail`) — the project's declared dependencies.
    // Emitted into the generated ShardDO's `studioFeatures()` override so the
    // studio hides only pages whose backing package the app genuinely never wires.
    const dependencies = discoverPackageDependencies(options.projectRoot);
    const studioFeatures = buildStudioFeatures(featureUsage, {
        cronCount: crons.length,
        dependencies,
        storageColumnCount: Object.keys(buildStorageColumns(schema)).length,
        storageRuleCount: storageRulesMetadata.rules.length,
        vectorIndexCount: schema.vectorIndexes.length,
        workflowCount: workflows.length,
    });

    // When the project depends on the `lunora` umbrella (instead of the granular
    // `@lunora/*` base packages), the generated files import the base surface
    // through the umbrella's subpaths (`lunorash/server`, `lunorash/do`, …) so the
    // app needs only the single `lunorash` dependency installed.
    const useUmbrella = dependencies.has("lunorash");

    const dataModelContent = emitDataModel(schema, useUmbrella);
    const apiContent = emitApi(functions, workflows, useUmbrella);
    const serverContent = emitServer({
        containers,
        hasAi,
        hasAnalytics,
        hasBrowser,
        hasHyperdrive,
        hasImages,
        hasKv,
        hasPayments,
        hasPipelines,
        schema,
        storageRuleBuckets: storageRulesMetadata.rules.map((rule) => rule.bucket),
        useUmbrella,
        workflows,
    });
    const functionsContent = emitFunctions(functions, migrations);
    const shardContent = emitShard({
        advisories,
        containers,
        hasAi,
        hasAnalytics,
        hasBrowser,
        hasHyperdrive,
        hasImages,
        hasKv,
        hasPayments,
        maskMetadata,
        rlsMetadata,
        schema,
        storageRules: storageRulesMetadata,
        studioFeatures,
        useUmbrella,
        workflows,
    });
    const containersContent = emitContainers(containers);
    const workflowsContent = emitWorkflows(workflows);
    const cronsContent = emitCrons(crons);
    const vectorsContent = emitVectors(schema.vectorIndexes);
    const drizzleFiles = emitDrizzleSchema(schema, useUmbrella);
    // Only emit the project-bound seed client when `@lunora/seed` is a declared
    // dependency — seeding is a dev/test concern, so a project that never
    // installs it keeps a clean `_generated/` and never imports the package.
    const seedContent = emitSeed(dependencies.has("@lunora/seed"));

    // Which API spec(s) the run emits. Defaults to `"openapi"` so existing
    // projects (and the golden fixtures) keep writing only `openapi.json`.
    const apiSpec = options.apiSpec ?? "openapi";
    const wantsOpenApi = apiSpec === "openapi" || apiSpec === "both";
    const wantsOpenRpc = apiSpec === "openrpc" || apiSpec === "both";

    // The fluent worker-composition builder. Emits one method per package-backed
    // capability the app uses (so IntelliSense lists exactly what's configurable),
    // each fanned into both the DO-side `createShardDO` factory and the worker-side
    // `createWorker` options. Lives in generated code (not the dependency-free
    // `@lunora/runtime`) so it can import the add-on packages the app installed.
    const appContent = emitApp({
        hasAi,
        hasAnalytics,
        hasAuth: dependencies.has("@lunora/auth"),
        hasBrowser,
        // Worker-composition framework adapters expose a `withLunora` over
        // `withFrameworkWorker`; when one is installed, surface `.buildFrameworkWorker()`.
        hasFramework: dependencies.has("@lunora/astro") || dependencies.has("@lunora/svelte") || dependencies.has("@lunora/vue"),
        // `hasGlobal` means **D1-backed** global tables (the `.global()` / D1
        // app-builder wiring); Hyperdrive-backed globals are gated separately by
        // `hasHyperdriveGlobal` so an app picks the right binding+package.
        hasGlobal: schema.tables.some((table) => table.shardMode === "global" && table.globalBackend !== "hyperdrive"),
        hasHyperdrive,
        hasHyperdriveGlobal: schema.tables.some((table) => table.shardMode === "global" && table.globalBackend === "hyperdrive"),
        hasImages,
        hasKv,
        hasPayments,
        hasScheduler: studioFeatures.scheduler,
        hasStorage: studioFeatures.storage,
        hasVectors: schema.vectorIndexes.length > 0,
        hasWorkflow: workflows.length > 0,
        useUmbrella,
        wantsOpenApi,
        wantsOpenRpc,
    });

    // Build each spec document once, then derive both artifacts from the same
    // object so the portable `.json` and the worker-importable `.ts` are
    // identical content and can never drift. Both are computed regardless of
    // `apiSpec` (cheap, pure) so `CodegenResult` can carry whichever the caller
    // asked for; only the requested file(s) are written.
    const projectVersion = readProjectVersion(options.projectRoot);
    const openApiDocument = buildOpenApiDocument({ functions, httpRoutes, version: projectVersion });
    const openRpcDocument = buildOpenRpcDocument({ functions, version: projectVersion });

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
    const schemaSnapshotPath = join(lunoraDirectory, SCHEMA_SNAPSHOT_FILENAME);
    const schemaSnapshotExists = existsSync(schemaSnapshotPath);

    const outputDirectory = join(lunoraDirectory, "_generated");

    if (!options.dryRun) {
        if (!existsSync(outputDirectory)) {
            mkdirSync(outputDirectory, { recursive: true });
        }

        writeIfChanged(join(outputDirectory, "app.ts"), appContent);
        writeIfChanged(join(outputDirectory, "dataModel.ts"), dataModelContent);
        writeIfChanged(join(outputDirectory, "api.ts"), apiContent);
        writeIfChanged(join(outputDirectory, "server.ts"), serverContent);
        writeIfChanged(join(outputDirectory, "functions.ts"), functionsContent);
        writeIfChanged(join(outputDirectory, "shard.ts"), shardContent);
        writeIfChanged(join(outputDirectory, "crons.ts"), cronsContent);
        writeIfChanged(join(outputDirectory, "vectors.ts"), vectorsContent);
        writeIfChanged(join(outputDirectory, "drizzle.global.ts"), drizzleFiles.global);
        writeIfChanged(join(outputDirectory, "drizzle.shard.ts"), drizzleFiles.shard);

        // Conditionally-emitted files: each is written only when its feature is
        // in use (the `emit*` helper returns `""` otherwise), so projects that
        // don't use them keep a clean `_generated/` and never import the package.
        //   - containers.ts  → `@lunora/container`, when containers are declared
        //   - workflows.ts   → `@lunora/workflow`, when workflows are declared
        //   - seed.ts        → `@lunora/seed`, when it's a declared dependency
        writeIfPresent(join(outputDirectory, "containers.ts"), containersContent);
        writeIfPresent(join(outputDirectory, "workflows.ts"), workflowsContent);
        writeIfPresent(join(outputDirectory, "seed.ts"), seedContent);

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
            app: appContent,
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
            seed: seedContent,
            server: serverContent,
            shard: shardContent,
            vectors: vectorsContent,
            workflows: workflowsContent,
        },
        outputDirectory,
        schemaSnapshot,
        schemaSnapshotPath,
        workflows,
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

    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    lunoraDirectory?: string;

    /**
     * Reuse a previously-constructed ts-morph {@link Project} instead of building
     * a fresh one each run. The caller owns refreshing its source files from disk
     * (see {@link refreshCodegenProject}) — codegen does not re-read changed files
     * off an injected Project. Built via {@link createCodegenProject} when absent.
     * Used by the Vite dev-loop to avoid re-parsing the whole TS program on every
     * save; omit it (CLI one-shot path) to get the default fresh-Project behaviour.
     */
    project?: Project;

    /** Project root containing the `lunora/` directory. */
    projectRoot: string;

    /**
     * Re-bless the committed schema-drift baseline (`lunora/.lunora-schema.json`)
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
     * `lunora/containers.ts` — the list the config layer reconciles into
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
        /** Fluent worker-composition builder (`_generated/app.ts`) — `defineApp()`. Always written. */
        app: string;
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
        /** Project-bound seed client (`_generated/seed.ts`); `""` (and not written) when `@lunora/seed` is not a declared dependency. */
        seed: string;
        server: string;
        shard: string;
        /** Static vector-index registry (`_generated/vectors.ts`) — `LUNORA_VECTOR_INDEXES`. Empty array body when the schema declares none. */
        vectors: string;
        /** WorkflowEntrypoint classes (`_generated/workflows.ts`); `""` (and not written) when no workflows are declared. */
        workflows: string;
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

    /** Absolute path of the committed baseline file (`lunora/.lunora-schema.json`). */
    schemaSnapshotPath: string;

    /**
     * Workflows discovered from `defineWorkflow` exports in
     * `lunora/workflows.ts` — the list the config layer reconciles into
     * wrangler's `workflows[]` array. Workflows are NOT Durable Objects, so this
     * adds no binding or migration. Empty when the project declares no workflows.
     */
    workflows: ReadonlyArray<WorkflowIR>;
}

// Exports kept at end-of-file per the package's `import/exports-last` rule.
export { SCHEMA_SNAPSHOT_FILENAME };
