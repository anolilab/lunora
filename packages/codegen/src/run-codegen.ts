import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { Finding, LintContext } from "@lunora/advisor";
import { runAdvisor } from "@lunora/advisor";
import { LunoraError } from "@lunora/errors";
import { Project } from "ts-morph";

import type { SchemaSnapshot } from "../../../shared/schema-snapshot";
import { serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
import { toAdvisorContext } from "./advisor";
import assertNoNamespaceCollisions from "./assert-namespace-collisions";
import { buildDeclarationSurface } from "./declaration-surface";
import discoverAdminRoutes from "./discover/admin-routes";
import discoverAiRawRuns from "./discover/ai-raw-runs";
import discoverAiToolSideEffects from "./discover/ai-tool-side-effects";
import discoverArgumentDerivedFetches from "./discover/argument-derived-fetches";
import discoverArgumentValidators from "./discover/argument-validators";
import { listLunoraSourceFiles } from "./discover/ast";
import discoverAuthConfig from "./discover/auth-config";
import discoverAuthApiCalls from "./discover/authapi-calls";
import discoverBrowserUrlAccesses from "./discover/browser-url-accesses";
import discoverConfigCalls from "./discover/config-calls";
import discoverContainerKeyAccesses from "./discover/container-key-accesses";
import discoverContainerOverrides from "./discover/container-overrides";
import discoverExportSinks from "./discover/export-sinks";
import discoverFailOpenGuards from "./discover/fail-open-guards";
import { discoverFlagKeys } from "./discover/flag-keys";
import discoverFlagReads from "./discover/flag-reads";
import discoverFlagSecurityDefaults from "./discover/flag-security-defaults";
import discoverFunctions from "./discover/functions";
import resolveStandardSchemaType from "./discover/functions/resolve-standard-schema-type";
import discoverGeoIndexUsages from "./discover/geo-index-usages";
import discoverHttpActionGuards from "./discover/http-action-guards";
import discoverHttpHeaderWrites from "./discover/http-header-writes";
import discoverHttpRoutes from "./discover/http-routes";
import discoverHyperdriveCalls from "./discover/hyperdrive-calls";
import discoverIdentityClaimReads from "./discover/identity-claim-reads";
import discoverImageDeliveryUrlAccesses from "./discover/image-delivery-url-accesses";
import discoverInserts from "./discover/inserts";
import discoverKvKeyAccesses from "./discover/kv-key-accesses";
import discoverMailRecipientAccesses from "./discover/mail-recipient-accesses";
import discoverMaskProcedures from "./discover/mask-procedures";
import discoverMaskHasNonLiteralPolicy from "./discover/mask-procedures/has-non-literal-policy";
import discoverMaskMetadata from "./discover/mask-procedures/metadata";
import discoverMaskStrategies from "./discover/mask-procedures/strategies";
import discoverMigrations from "./discover/migrations";
import discoverMutatorWrites from "./discover/mutator-writes";
import { discoverMutators } from "./discover/mutators";
import discoverNondeterministicCalls from "./discover/nondeterministic-calls";
import discoverNormalizeIdAuthorization from "./discover/normalize-id-authorization";
import { discoverNotifyCalls, discoverNotifyConfig } from "./discover/notify";
import discoverOwnerFieldWrites from "./discover/owner-field-writes";
import hasPaymentStoreTables from "./discover/payment-store-tables";
import discoverPaymentWebhooks from "./discover/payment-webhooks";
import discoverPrivilegedDispatches from "./discover/privileged-dispatches";
import discoverProcedureMiddleware from "./discover/procedure-middleware";
import discoverQueries from "./discover/queries";
import discoverR2sqlCalls from "./discover/r2sql-calls";
import discoverRatelimitKeySelectors from "./discover/ratelimit-key-selectors";
import discoverRawRowReturns from "./discover/raw-row-returns";
import discoverRelationLoads from "./discover/relation-loads";
import discoverRlsProcedures from "./discover/rls-procedures";
import discoverRlsMetadata from "./discover/rls-procedures/metadata";
import discoverSchema from "./discover/schema";
import discoverSecrets from "./discover/secrets";
import { discoverShapes } from "./discover/shapes";
import discoverSoftDeleteReads from "./discover/soft-delete-reads";
import discoverSqlInterpolation from "./discover/sql-interpolation";
import discoverStaleMigrationImports from "./discover/stale-migration-imports";
import discoverStorageKeyAccesses from "./discover/storage-key-accesses";
import discoverStorageUploads from "./discover/storage-uploads";
import { buildStudioFeatures } from "./discover/studio-features";
import discoverUnregisteredProcedures from "./discover/unregistered-procedures";
import discoverUnrestrictedWhereBranches from "./discover/unrestricted-where-branches";
import discoverVectorNamespaceAccesses from "./discover/vector-namespace-accesses";
import discoverWorkflowCalls from "./discover/workflow-calls";
import {
    buildStorageColumns,
    emitAgents,
    emitApi,
    emitCollections,
    emitContainers,
    emitCrons,
    emitDrizzleSchema,
    emitFunctions,
    emitQueues,
    emitSeed,
    emitShard,
    emitVectors,
    emitWorkflows,
    emitWranglerCronTriggers,
} from "./emit";
import { emitApp } from "./emit-app";
import type {
    AgentIR,
    ContainerIR,
    FunctionIR,
    HttpRouteIR,
    MaskMetadataIR,
    MigrationIR,
    MutatorIR,
    QueueIR,
    ShapeIR,
    WorkflowIR,
    WranglerVariableIR,
} from "./ir";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";
import { setStandardTypeResolver } from "./parse-validator";
import type { PlatformDiagnostic } from "./platform-target";
import { buildSchemaSnapshot } from "./schema-drift";

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
 * Write a conditionally-emitted `_generated/` file, or **delete a stale one**.
 * When `content` is the empty string (the convention `emit*` helpers use to mean
 * "not applicable") the feature is not in use, so any file left at `filePath`
 * from a prior run — when the feature WAS in use — is removed. Without this, a
 * removed feature (last container/workflow/queue deleted, `@lunora/db` /
 * `@lunora/seed` uninstalled) would leave a lingering `_generated/<feature>.ts`
 * that imports a now-absent package and breaks the build. `force: true` no-ops
 * when the file never existed. Only ever called for the known conditional set
 * (containers/workflows/queues/seed/collections and the openapi/openrpc spec
 * artifacts), so it never touches an unrelated file. Keeps the per-feature gating
 * out of `runCodegen`'s control flow.
 */
const writeIfPresent = (filePath: string, content: string): void => {
    if (content === "") {
        rmSync(filePath, { force: true });

        return;
    }

    writeIfChanged(filePath, content);
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
 * Whether opt-in codegen timing is enabled. Gated on a truthy
 * `LUNORA_CODEGEN_TIMING` env var so a normal run is byte-for-byte unchanged:
 * no timers are read, no summary is printed. An empty string (`""`) counts as
 * unset, matching how shells export blank vars.
 */
const isTimingEnabled = (): boolean => {
    const flag = process.env["LUNORA_CODEGEN_TIMING"];

    return flag !== undefined && flag !== "";
};

/**
 * Walk up from `startPath` until we find a `tsconfig.json` or hit the file
 * system root. Returns the absolute path to the tsconfig, or `undefined`.
 *
 * Exported (see the bottom-of-file `export { findTsconfig }`) so a long-lived
 * caller (the Vite dev-loop's cached-Project invalidation) can ask "which
 * tsconfig would {@link createCodegenProject} resolve right now?" without
 * duplicating the walk — recomputing it per call is a handful of `existsSync`
 * checks, negligible next to a Project rebuild.
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

/* eslint-disable jsdoc/check-indentation, no-secrets/no-secrets -- intentional nested bullet list; the `discoverMaskHasNonLiteralPolicy` back-tick reference isn't a credential */

/**
 * Fail closed (plan 208, Phase 1) when a `defineShape` replicates a table any
 * `.use(mask(...))` chain masks a column on. A shape runs no procedure, so
 * `.use(mask(...))` never executes for its membership reads — without this
 * check it would replicate a masked column's raw value to every subscribed
 * client, silently. Masking a shape's replicated rows (Phase 2) isn't built
 * yet, so the only safe answer today is to refuse the combination outright —
 * the same secure-by-default posture RLS's `.rls("required")` denial takes
 * for a policy-less table.
 *
 * Cross-checks project-wide static facts — `discoverShapes`' `ShapeIR.table`,
 * `discoverMaskMetadata`'s masked `(table, column)` pairs, and
 * `discoverMaskHasNonLiteralPolicy`'s "codegen couldn't read every mask policy"
 * signal — rather than reading any runtime tag/registry, so this rejects the
 * collision at build time, before a single Durable Object ships. Runs
 * unconditionally (all three inputs are computed regardless of the `lint`
 * option), because a security invariant must not be optional the way an
 * advisor lint finding is.
 *
 * Two inputs codegen can't statically resolve to a certain answer, handled by
 * failing closed rather than silently passing:
 *
 * - A shape's `table` isn't a string literal (e.g. `defineShape({ table: t,
 *   ... })` for a hoisted `t`) — `ShapeIR.table` is `undefined`, and codegen
 *   cannot rule out that `t` names a masked table. Only enforced when the
 *   project masks at least one column somewhere — a mask-free project has
 *   nothing such a shape could leak, so it's let through unconditionally.
 * - A `mask(policies)` call's `policies` argument is a variable reference
 *   rather than an inline object literal (e.g. `mask(sharedPolicies)`) — it
 *   contributes zero columns to `maskMetadata`, so the per-table lookup below
 *   has no evidence for whichever table(s) it actually masks. Once codegen
 *   can't enumerate every masked column, it can't clear ANY shape, so this
 *   fires unconditionally whenever the project declares both such a call and
 *   at least one shape.
 */
/* eslint-enable jsdoc/check-indentation, no-secrets/no-secrets */
const assertNoMaskedShapeTable = (shapes: ReadonlyArray<ShapeIR>, maskMetadata: MaskMetadataIR, hasNonLiteralMaskPolicy: boolean): void => {
    if (hasNonLiteralMaskPolicy && shapes.length > 0) {
        const shapeList = shapes.map((shape) => `"${shape.exportName}"`).join(", ");

        throw new LunoraError(
            "MASK_UNSUPPORTED",
            `This project declares a \`mask(...)\` policy whose argument isn't a plain object literal (e.g. \`mask(sharedPolicies)\` referencing a hoisted variable), or contains a spread (\`...shared\`) or computed key (\`[name]:\`) codegen can't enumerate, so codegen can't tell which columns it masks. Because the project also declares replication shape(s) (${shapeList}), codegen can't verify none of them replicate a table that policy masks — inline every table and column as literal keys so codegen can verify it, or remove the affected shape(s).`,
            { status: 422 },
        );
    }

    const maskedColumnsByTable = new Map<string, string[]>();

    for (const column of maskMetadata.columns) {
        const columns = maskedColumnsByTable.get(column.table) ?? [];

        columns.push(column.column);
        maskedColumnsByTable.set(column.table, columns);
    }

    const projectHasMaskedColumns = maskMetadata.columns.length > 0;

    for (const shape of shapes) {
        if (shape.table === undefined) {
            // Codegen couldn't statically prove which table this shape targets — its
            // `table` config value isn't a string literal (see `tableLiteralFrom`).
            // A mask-free project has nothing this shape could leak, so it's let
            // through; a project that masks ANY column can't rule out this shape
            // targeting one of them, and a shape runs no procedure (so
            // `.use(mask(...))` never applies to it) — fail closed rather than risk
            // replicating a masked column raw.
            if (projectHasMaskedColumns) {
                throw new LunoraError(
                    "MASK_UNSUPPORTED",
                    `defineShape "${shape.exportName}" has a non-literal \`table\` (a variable or expression, not a string literal), so codegen can't statically verify it doesn't replicate a table that masks a column. This project masks at least one column elsewhere, so the combination can't be proven safe — change "${shape.exportName}"'s \`table\` to a plain string literal so codegen can verify it, or remove the mask(s) on the table it targets.`,
                    { status: 422 },
                );
            }

            continue;
        }

        const maskedColumns = maskedColumnsByTable.get(shape.table);

        if (maskedColumns === undefined) {
            continue;
        }

        const columnList = maskedColumns.map((column) => `"${column}"`).join(", ");

        throw new LunoraError(
            "MASK_UNSUPPORTED",
            `defineShape "${shape.exportName}" replicates table "${shape.table}", which masks column(s) ${columnList} on at least one procedure. A shape runs no procedure, so \`.use(mask(...))\` never applies to its replicated rows — remove the shape, unmask the table, or wait for shape-masking support.`,
            { status: 422 },
        );
    }
};

/**
 * Point `project`'s copy of `filePath` at `content`, without disturbing a file
 * that already matches. Absent, `createSourceFile` adds it (the cold-start
 * case). Present and identical, it is left untouched — every warm run of an
 * unchanged project, where doing nothing keeps the fully-resolved program the
 * Project was constructed with.
 *
 * Present but stale, it is rewritten IN PLACE with `replaceWithText`.
 * `createSourceFile` with the overwrite option looks equivalent and is not: it
 * swaps in a NEW SourceFile, so every already-loaded handler module still points
 * at the old, now-orphaned one and its `dataModel` type import stops resolving.
 */
const syncProjectFile = (project: Project, filePath: string, content: string): void => {
    const existing = project.getSourceFile(filePath);

    if (existing === undefined) {
        project.createSourceFile(filePath, content, { overwrite: true });

        return;
    }

    if (existing.getFullText() === content) {
        return;
    }

    existing.replaceWithText(content);
};

/** Whether `project` already holds `filePath` with exactly `content`. */
const projectFileMatches = (project: Project, filePath: string, content: string): boolean => project.getSourceFile(filePath)?.getFullText() === content;

/**
 * Ceiling on the infer → render → re-infer loop below. Cold trees were measured
 * converging on the fourth pass, so the cap sits above that with room. It is a spin guard, not a correctness guarantee — see
 * {@link inferToFixpoint} for what happens when it is reached.
 */
const MAX_INFERENCE_PASSES = 8;

/**
 * Infer every handler's return type against a project that already contains the
 * `api.ts` / `functions.ts` those types are read back through.
 *
 * `dataModel.ts` and `server.ts` are rendered into the project before any
 * inference happens, precisely so a cold tree cannot collapse the types that
 * depend on them. These two cannot be seeded that way, because their content IS
 * the inference result: a handler doing `ctx.runQuery(api.messages.list)` — or a
 * streaming route whose chunk type comes back through one — infers against a
 * module that does not exist yet on a cold `_generated/`, collapses, and the
 * collapse is written out. The tree then converges only on a later invocation,
 * which is what pushes projects into wrapping the CLI in a
 * run-until-the-hash-stops-changing loop (issue #283).
 *
 * So iterate: infer, render, feed the render back, re-infer. The loop returns as
 * soon as a pass's render matches what inference already saw — the first pass on
 * any warm tree, where `syncProjectFile` leaves an identical file alone and
 * nothing is re-inferred, so a converged project pays one extra render and no
 * extra inference.
 *
 * The render that matched is RETURNED rather than recomputed by the caller. Two
 * call sites building the same emit arguments 150 lines apart is how the
 * convergence check silently starts comparing something other than what gets
 * written.
 *
 * **Reaching the cap is not an error.** A handler that embeds its own result —
 * `{ deeper: await createCaller(ctx).grow.grow() }`, the shape of any
 * self-referential tree query — grows its inferred type by one level per pass
 * and has no fixpoint to reach. Throwing there would turn a project that
 * previously built (with that one return typed `unknown`) into one that produces
 * no `_generated/` at all. So the last render wins, exactly as it did before this
 * loop existed: never worse than one run's output, usually better.
 */
const inferToFixpoint = (options: {
    agents: ReadonlyArray<AgentIR>;
    apiPath: string;
    generatedFunctionsPath: string;
    lunoraDirectory: string;
    migrations: ReadonlyArray<MigrationIR>;
    project: Project;
    shapes: ReadonlyArray<ShapeIR>;
    usesSandbox: boolean;
    useUmbrella: boolean;
    workflows: ReadonlyArray<WorkflowIR>;
}): {
    apiContent: string;
    functions: ReadonlyArray<FunctionIR>;
    functionsContent: string;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    mutators: ReadonlyArray<MutatorIR>;
} => {
    const { agents, apiPath, generatedFunctionsPath, lunoraDirectory, migrations, project, shapes, usesSandbox, useUmbrella, workflows } = options;

    // The three discoverers that read an inferred return type through
    // `unwrapHandlerReturn`, and therefore the three that have to be re-run when
    // the files those types resolve against change. Everything else in the
    // pipeline reads syntax, not inference, and stays outside.
    let functions = discoverFunctions(project, lunoraDirectory);
    let mutators = discoverMutators(project, lunoraDirectory);
    let httpRoutes = discoverHttpRoutes(project, lunoraDirectory);

    // Two files whose sanitized namespaces collide (`a-b.ts` + `a_b.ts`) would
    // emit the same key twice into `_generated/api.ts` — a TS2300 inside
    // generated code, with no pointer back to the two files that caused it.
    //
    // Once per namespace SPACE: `api.*` and `httpStreams.*` are separate emitted
    // objects, so a function file may share a namespace with a route file, but
    // two streaming-route files may not — and only `.stream()` routes are
    // grouped by namespace at all, so the plain verbs stay out of it.
    assertNoNamespaceCollisions([...functions, ...mutators].map((definition) => definition.filePath));
    assertNoNamespaceCollisions(
        httpRoutes.filter((route) => route.stream).map((route) => route.filePath),
        "http-stream",
    );

    for (let pass = 1; ; pass += 1) {
        const apiContent = emitApi({ agents, functions, httpRoutes, mutators, useUmbrella, workflows });
        const functionsContent = emitFunctions({ agents, functions, migrations, mutators, shapes, useUmbrella, usesSandbox });

        // Converged, or out of budget — either way this render is the answer, and
        // the budget check sits HERE so the final pass's re-inference is never
        // computed and then discarded.
        if (
            pass >= MAX_INFERENCE_PASSES ||
            (projectFileMatches(project, apiPath, apiContent) && projectFileMatches(project, generatedFunctionsPath, functionsContent))
        ) {
            return { apiContent, functions, functionsContent, httpRoutes, mutators };
        }

        syncProjectFile(project, apiPath, apiContent);
        syncProjectFile(project, generatedFunctionsPath, functionsContent);

        functions = discoverFunctions(project, lunoraDirectory);
        mutators = discoverMutators(project, lunoraDirectory);
        httpRoutes = discoverHttpRoutes(project, lunoraDirectory);
    }
};

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
 * Files outside `lunoraDirectory` — e.g. a shared validator or type pulled in
 * via the user's tsconfig — are also `refreshFromFileSystemSync()`ed, but only
 * the ones already loaded into the Project; none are added. `resolveValidatorAlias`
 * (parse-validator.ts) follows `getAliasedSymbol()` across module boundaries, so a
 * validator defined outside `lunoraDirectory` is genuinely read from whatever
 * source the Project currently holds — leaving those files stale made a reused
 * Project (the Vite dev loop) silently disagree with a fresh one (`lunora
 * codegen`) about the same source. `node_modules` is excluded: its `.d.ts` set
 * dominates the file count and never changes mid dev-loop, so refreshing it would
 * reinstate close to the full re-parse cost this cache exists to avoid.
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

    // Second pass: resync everything else the Project already has loaded (type
    // resolution reached past `lunoraDirectory` — a shared validator, a type
    // alias, whatever the user's tsconfig program pulled in). `node_modules` is
    // skipped on purpose (see docblock); a file under it never changes here.
    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();

        if (filePath === lunoraRoot || filePath.startsWith(lunoraPrefix) || filePath.includes("/node_modules/")) {
            continue;
        }

        try {
            sourceFile.refreshFromFileSystemSync();
        } catch {
            // Deleted (or unreadable) since it was loaded — drop it rather than
            // let a throw here wedge the dev loop. `refreshFromFileSystemSync`
            // already forgets a genuinely-deleted file on its own; this guard is
            // for the rarer I/O-error case (e.g. a permission change).
            project.removeSourceFile(sourceFile);
        }
    }
};

/**
 * Top-level codegen entry. Parses `<projectRoot>/lunora/schema.ts` and every
 * function file under `<projectRoot>/lunora/`, then writes
 * `_generated/{api,server,dataModel}.ts` next to them.
 *
 * When `LUNORA_CODEGEN_TIMING` is set (truthy), a single diagnostic summary
 * line is written to stderr with the total wall time and the discovery-vs-emit
 * split — opt-in instrumentation that is otherwise zero-cost and side-effect-free
 * on the returned {@link CodegenResult}.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- top-level codegen orchestrator; splitting further would obscure the linear pipeline
export const runCodegen = (options: CodegenOptions): CodegenResult => {
    const timingEnabled = isTimingEnabled();
    const startedAt = timingEnabled ? performance.now() : 0;

    const lunoraDirectory = join(options.projectRoot, options.lunoraDirectory ?? "lunora");
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        throw new LunoraError("INTERNAL", `schema.ts not found at ${schemaPath}`);
    }

    // Reuse an injected Project (the caller owns refreshing its source files
    // from disk — see refreshCodegenProject) when provided; otherwise build one
    // exactly as createCodegenProject would.
    const project = options.project ?? createCodegenProject(lunoraDirectory);

    // MUST run before anything parses validators — `discoverSchema` and
    // `discoverFunctions` below are where `v.from(...)` is read, and an
    // unregistered resolver silently yields `unknown` for every one of them.
    // Recovering the type needs the checker plus the generated-file
    // renderability guards, both of which live in `discover/functions`;
    // registered here rather than imported by the parser, which would be a
    // cycle.
    setStandardTypeResolver(resolveStandardSchemaType);

    const schema = discoverSchema(project, schemaPath, options.projectRoot);

    // Phase 1 — everything that must be resolved and RENDERED before a single
    // handler's type is inferred against it. See `declaration-surface.ts` for why
    // that ordering is load-bearing; the short version is that a handler's type
    // resolves through `dataModel.ts`/`server.ts`, so rendering them late makes
    // pass 1 infer against the previous run's declarations.
    const {
        agents,
        containers,
        crons,
        dataModelContent,
        dependencies,
        env,
        featureUsage,
        hasFlags,
        hasNotify,
        identity,
        platformGate,
        queues,
        serverContent,
        storageRulesMetadata,
        usesSandbox,
        useUmbrella,
        workflows,
    } = buildDeclarationSurface({ lunoraDirectory, project, projectRoot: options.projectRoot, schema, target: options.target });

    const outputDirectory = join(lunoraDirectory, "_generated");
    const dataModelPath = join(outputDirectory, "dataModel.ts");
    const serverPath = join(outputDirectory, "server.ts");
    const apiPath = join(outputDirectory, "api.ts");
    const generatedFunctionsPath = join(outputDirectory, "functions.ts");

    // In MEMORY only — the disk write waits for the write phase with everything
    // else. `discoverFunctions` infers against the ts-morph `Project`, not the
    // filesystem, so this is the whole of what makes the declarations current;
    // writing here as well would buy nothing and cost atomicity. Anything between
    // this point and the write phase can throw (`assertNoMaskedShapeTable`, a
    // parse error in a handler), and an early write would leave a new
    // `dataModel.ts` beside a stale `api.ts`/`shard.ts` — worst when a table was
    // REMOVED, since `Doc_x` disappears while the files still referencing it do
    // not, and the resulting errors point at generated code rather than the real
    // cause. It would also fire the `_generated/**` watcher mid-failure in the
    // Vite dev loop.
    syncProjectFile(project, dataModelPath, dataModelContent);
    syncProjectFile(project, serverPath, serverContent);

    const migrations = discoverMigrations(project, lunoraDirectory);

    // Local-first sync engine (Phase 7): replication shapes (`lunora/shapes.ts`)
    // and custom mutators (`lunora/mutators.ts`). Shapes gate the generated DO's
    // `resolveShape` override + the `_generated/collections.ts` factories;
    // mutators register into `LUNORA_FUNCTIONS` (transaction-wrapped) and the
    // `isCustomMutator` push-protocol override. Both return `[]` when their file
    // is absent, so a project without them emits byte-identical generated code.
    // Neither reads a handler's inferred return type, so both sit outside the
    // fixpoint below — unlike `discoverHttpRoutes`, which does.
    const shapes = discoverShapes(project, lunoraDirectory);

    const { apiContent, functions, functionsContent, httpRoutes, mutators } = inferToFixpoint({
        agents,
        apiPath,
        generatedFunctionsPath,
        lunoraDirectory,
        migrations,
        project,
        shapes,
        useUmbrella,
        usesSandbox,
        workflows,
    });

    // Static advisories (unindexed FKs, redundant indexes, unknown index/relation
    // fields, filter-without-index, …). Cheap, derived from the schema + the
    // discovered query reads, and run here so a problem surfaces at codegen time
    // — before it ships. Opt out via `lint: false`. Presentation is the caller's
    // job: the result carries the findings and each caller surfaces them through
    // its own channel (the CLI logger, the vite overlay, the studio Advisors
    // table) rather than this library printing.
    //
    // One context feeds both the findings and the scored health map, so the two can
    // never describe different evidence. Built lazily — the ternary keeps every
    // discover* call out of a `lint: false` run.
    const advisorContext =
        options.lint === false
            ? undefined
            : toAdvisorContext({
                  adminRoutes: discoverAdminRoutes(project, lunoraDirectory),
                  aiRawRuns: discoverAiRawRuns(project, lunoraDirectory),
                  aiToolSideEffects: discoverAiToolSideEffects(project, lunoraDirectory),
                  argumentDerivedFetches: discoverArgumentDerivedFetches(project, lunoraDirectory),
                  argumentValidators: discoverArgumentValidators(project, lunoraDirectory),
                  authApiCalls: discoverAuthApiCalls(project, lunoraDirectory),
                  authConfigs: discoverAuthConfig(project, lunoraDirectory),
                  browserUrlAccesses: discoverBrowserUrlAccesses(project, lunoraDirectory),
                  configCalls: discoverConfigCalls(project, lunoraDirectory),
                  containerKeyAccesses: discoverContainerKeyAccesses(project, lunoraDirectory),
                  containerOverrides: discoverContainerOverrides(project, lunoraDirectory),
                  containers,
                  exportSinks: discoverExportSinks(project, lunoraDirectory),
                  staleMigrationImports: discoverStaleMigrationImports(project, lunoraDirectory),
                  failOpenGuards: discoverFailOpenGuards(project, lunoraDirectory),
                  flagReads: discoverFlagReads(project, lunoraDirectory),
                  flagSecurityDefaults: discoverFlagSecurityDefaults(project, lunoraDirectory),
                  geoIndexUsages: discoverGeoIndexUsages(project, lunoraDirectory),
                  httpActionGuards: discoverHttpActionGuards(project, lunoraDirectory),
                  httpHeaderWrites: discoverHttpHeaderWrites(project, lunoraDirectory),
                  hyperdriveCalls: discoverHyperdriveCalls(project, lunoraDirectory),
                  identityClaimReads: discoverIdentityClaimReads(project, lunoraDirectory),
                  imageDeliveryUrlAccesses: discoverImageDeliveryUrlAccesses(project, lunoraDirectory),
                  inserts: discoverInserts(project, lunoraDirectory),
                  kvKeyAccesses: discoverKvKeyAccesses(project, lunoraDirectory, functions),
                  mailRecipientAccesses: discoverMailRecipientAccesses(project, lunoraDirectory),
                  maskProcedures: discoverMaskProcedures(project, lunoraDirectory),
                  maskStrategies: discoverMaskStrategies(project, lunoraDirectory),
                  mutatorWrites: discoverMutatorWrites(project, lunoraDirectory),
                  nondeterministicCalls: discoverNondeterministicCalls(project, lunoraDirectory),
                  normalizeIdAuthorizations: discoverNormalizeIdAuthorization(project, lunoraDirectory),
                  notifyCalls: discoverNotifyCalls(project, lunoraDirectory),
                  notifyConfig: discoverNotifyConfig(project, lunoraDirectory),
                  ownerFieldWrites: discoverOwnerFieldWrites(project, lunoraDirectory, functions),
                  unrestrictedWhereBranches: discoverUnrestrictedWhereBranches(project, lunoraDirectory),
                  paymentWebhooks: discoverPaymentWebhooks(project, lunoraDirectory),
                  privilegedDispatches: discoverPrivilegedDispatches(project, lunoraDirectory),
                  procedureProtections: discoverProcedureMiddleware(project, lunoraDirectory),
                  queries: discoverQueries(project, lunoraDirectory),
                  queues,
                  r2sqlCalls: discoverR2sqlCalls(project, lunoraDirectory),
                  ratelimitKeySelectors: discoverRatelimitKeySelectors(project, lunoraDirectory),
                  rawRowReturns: discoverRawRowReturns(project, lunoraDirectory),
                  relationLoads: discoverRelationLoads(project, lunoraDirectory),
                  rlsProcedures: discoverRlsProcedures(project, lunoraDirectory),
                  schema,
                  secretLiterals: discoverSecrets(project, lunoraDirectory),
                  shapes,
                  softDeleteReads: discoverSoftDeleteReads(project, lunoraDirectory),
                  sqlInterpolations: discoverSqlInterpolation(project, lunoraDirectory),
                  storageKeyAccesses: discoverStorageKeyAccesses(project, lunoraDirectory, functions),
                  storageUploads: discoverStorageUploads(project, lunoraDirectory),
                  vectorNamespaceAccesses: discoverVectorNamespaceAccesses(project, lunoraDirectory),
                  workflowCalls: discoverWorkflowCalls(project, lunoraDirectory),
                  workflows,
                  wranglerVariables: options.wranglerVariables,
              });

    // A binding whose TYPE is a registered procedure but which never reached
    // `api.ts` was dropped by the syntactic scan. Reported alongside the
    // advisor's findings so it travels the same channel to the terminal and the
    // studio.
    const advisories =
        advisorContext === undefined
            ? []
            : [...runAdvisor(advisorContext, { source: "static" }), ...discoverUnregisteredProcedures(project, lunoraDirectory, functions)];

    // Read-only RLS metadata (policies + roles) the studio's RLS inspector lists,
    // emitted into the generated ShardDO's `rlsMetadata()` override. Statically
    // discovered from every `.use(rls(...))` chain — never the `when` predicate.
    const rlsMetadata = discoverRlsMetadata(project, lunoraDirectory);

    // Read-only masking metadata (table + column + strategy) the studio's
    // data-browser mask toggle previews, emitted into the generated ShardDO's
    // `maskMetadata()` override. Statically discovered from every
    // `.use(mask(...))` chain — never the masking closure.
    const maskMetadata = discoverMaskMetadata(project, lunoraDirectory);

    // Fail closed (plan 208, Phase 1): a `defineShape` runs no procedure, so
    // masking never applies to its replicated rows — reject the combination
    // before it ships rather than replicate a masked column raw. Unconditional
    // (not gated behind `lint`), unlike the advisories below. Also covers the
    // two cases codegen can't prove safe rather than prove unsafe — a shape's
    // non-literal `table` and a mask() call's non-literal `policies` — see
    // eslint-disable-next-line no-secrets/no-secrets -- false positive: this is a function name referenced in a comment, not a secret.
    // `discoverMaskHasNonLiteralPolicy` and `assertNoMaskedShapeTable`'s docblock.
    assertNoMaskedShapeTable(shapes, maskMetadata, discoverMaskHasNonLiteralPolicy(project, lunoraDirectory));

    // Statically-discovered `ctx.flags.<type>("key")` reads — the generated
    // ShardDO's `evaluateFlags` (studio Flags page) + the reactive read override
    // (`useFlag`) iterate these. Only meaningful when a provider is wired.
    const flagKeys = hasFlags ? discoverFlagKeys(project, lunoraDirectory) : [];

    // The platform gate's `vectorStore` verdict, named once for every consumer
    // below. `undefined` means the app never declared a vector index, which must
    // not withhold anything; only an explicit `false` is a rejection. Spelling
    // that three-state comparison out per call site is what let one of them —
    // the studio nav — keep advertising the feature the other two withheld.
    const vectorStoreSupported = platformGate.signals.vectorStore !== false;

    // Which optional, package-backed features the studio should show a nav page
    // for. `buildStudioFeatures` OR's the code-usage flags with the schema/project
    // signals the `lunora/`-scoped scan can't see: storage columns + access rules,
    // declared crons, vector indexes, and — crucially for packages wired only in
    // the worker entry (e.g. `@lunora/mail`) — the project's declared dependencies.
    // Emitted into the generated ShardDO's `studioFeatures()` override so the
    // studio hides only pages whose backing package the app genuinely never wires.
    const studioFeatures = buildStudioFeatures(featureUsage, {
        containerCount: containers.length,
        cronCount: crons.length,
        dependencies,
        // Payments gates on the store tables the panel reads being declared, not on a
        // bare `@lunora/payment` dependency (which may be present only to reuse the
        // package's pure webhook helpers). Matched by the tables' *signature columns*
        // (not their generic names), so an unrelated `subscriptions`/`events` table
        // does not spuriously show the page — see `hasPaymentStoreTables`.
        hasPaymentTables: hasPaymentStoreTables(schema.tables),
        queueCount: queues.length,
        storageColumnCount: Object.keys(buildStorageColumns(schema)).length,
        storageRuleCount: storageRulesMetadata.rules.length,
        vectorIndexCount: schema.vectorIndexes.length,
        vectorStoreSupported,
        workflowCount: workflows.length,
    });

    // Boundary between the discovery phase (all `discover*` passes + the inline
    // discovers `lintSchema` drives + the metadata discovers above) and the emit
    // phase (the `emit*`/`build*`/serialize work + the file writes below).
    // `dataModel.ts`/`server.ts` are already RENDERED further up — they are the
    // declaration surface inference reads, so they cannot wait for this phase.
    // They are not yet WRITTEN: the write happens with every other file below, so
    // a throw between here and there leaves `_generated/` untouched.
    const emitStartedAt = timingEnabled ? performance.now() : 0;

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
    // The SAME snapshot is threaded into the emitted shard so the DO records it
    // in its `__lunora_schema_history` ledger on cold start (plan 200). One
    // builder feeds both the deploy gate and the Studio's schema history, so the
    // two can never describe different shapes.
    const shardContent = emitShard({
        advisories,
        advisorProcedures: advisorContext?.procedureProtections ?? [],
        agents,
        containers,
        env,
        flagKeys,
        hasAccessFacade: featureUsage.access,
        hasAi: featureUsage.ai,
        hasAnalytics: featureUsage.analytics,
        hasBrowser: featureUsage.browser,
        hasFlags,
        hasHyperdrive: featureUsage.hyperdrive,
        hasImages: featureUsage.images,
        hasKv: featureUsage.kv,
        hasNotify,
        hasPayments: featureUsage.payments,
        hasPipelines: featureUsage.pipelines,
        hasR2sql: featureUsage.r2sql,
        // The gate's verdict, exactly as `emitServer`/`emitApp` receive it. The
        // shard emitter recomputed the flag from `schema.vectorIndexes` instead,
        // so the DO kept the whole Vectorize wiring on a host rating
        // `vectorStore: "unsupported"` — a `generated.shard` byte-identical to
        // the Cloudflare one while the type surface was withheld.
        hasVectors: vectorStoreSupported,
        hasX402: featureUsage.x402,
        maskMetadata,
        mutators,
        queues,
        rlsMetadata,
        schema,
        schemaSnapshot,
        shapes,
        storageRules: storageRulesMetadata,
        studioFeatures,
        useUmbrella,
        workflows,
    });
    // `_generated/collections.ts` — one TanStack DB collection factory per shape.
    // Emitted only when the project declares shapes AND installs the `@lunora/db`
    // add-on (which ships `lunoraCollectionOptions`); `""` otherwise so
    // `writeIfPresent` skips it.
    const collectionsContent = emitCollections(shapes, dependencies.has("@lunora/db"), useUmbrella);
    const containersContent = emitContainers(containers, schema.jurisdiction);
    const workflowsContent = emitWorkflows(workflows);
    const agentsContent = emitAgents(agents);
    const queuesContent = emitQueues(queues);
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
        // Inbound-email agents (`defineAgent({ onEmail })`) → wire the worker's
        // top-level `email()` handler to each agent's `AGENT_*` Workflow binding so
        // received mail starts a durable run. Empty for email-free (and agent-free)
        // projects, so the emitted app.ts stays byte-identical.
        emailAgents: agents
            .filter((agent) => agent.onEmail === true)
            .map((agent) => {
                return { bindingName: agent.bindingName, exportName: agent.exportName };
            }),
        hasAccess: dependencies.has("@lunora/cloudflare-access"),
        hasAi: featureUsage.ai,
        hasAnalytics: featureUsage.analytics,
        hasAuth: dependencies.has("@lunora/auth"),
        hasBrowser: featureUsage.browser,
        // Worker-composition framework adapters expose a `withLunora` over
        // `withFrameworkWorker`; when one is installed, surface `.buildFrameworkWorker()`.
        hasFramework: dependencies.has("@lunora/astro") || dependencies.has("@lunora/svelte") || dependencies.has("@lunora/vue"),
        // `hasGlobal` means **D1-backed** global tables (the `.global()` / D1
        // app-builder wiring); Hyperdrive-backed globals are gated separately by
        // `hasHyperdriveGlobal` so an app picks the right binding+package.
        hasGlobal: schema.tables.some((table) => table.shardMode === "global" && table.globalBackend !== "hyperdrive"),
        hasHyperdrive: featureUsage.hyperdrive,
        hasHyperdriveGlobal: schema.tables.some((table) => table.shardMode === "global" && table.globalBackend === "hyperdrive"),
        hasImages: featureUsage.images,
        // The `.kv()` builder's parameter type reads `ShardConfig["kv"]`, and that
        // config field is emitted on the usage signal — so this MUST stay
        // usage-only or the emitted method references a type that is not there.
        hasKv: featureUsage.kv,
        // Auto-wire the studio's KV introspector on the SAME condition the nav
        // gates its tab on (`studioFeatures.kv` = ctx.kv usage OR a declared
        // `@lunora/bindings` dep), so a visible KV tab always has a working
        // backend — never the reverse.
        hasKvIntrospector: studioFeatures.kv,
        hasNotify,
        hasPayments: featureUsage.payments,
        hasR2sql: featureUsage.r2sql,
        hasQueue: queues.some((queue) => queue.mode === "push"),
        hasScheduler: studioFeatures.scheduler,
        hasStorage: studioFeatures.storage,
        // The gate's verdict, on the same convention `emitServer`/`emitShard`
        // take it: the emitter AND's it with the declaration itself. This call
        // site used to pass the CONJUNCTION under the same prop name, so the one
        // flag meant two different things depending on which emitter read it.
        hasVectors: vectorStoreSupported,
        hasWorkflow: workflows.length > 0,
        hasX402: featureUsage.x402,
        // The single `defineIdentity(...)` contract (Plan 080). Wires
        // `options.identity` so the runtime trust boundary validates every
        // resolved identity before it becomes `ctx.auth`; `undefined` keeps the
        // emitted app.ts byte-identical to before this feature.
        identity,
        // Schema `.jurisdiction("…")` → pin the generated worker's DOs to the region.
        jurisdiction: schema.jurisdiction,
        // Drives the emitted `listSchemaTables` — export's seed for "every table".
        tableNames: schema.tables.map((table) => table.name),
        useUmbrella,
        // The app's own declaration, which `emitApp` AND's with `hasVectors`.
        // `emitApp` takes no schema (it takes the table NAMES), so the count it
        // needs to make the same decision its siblings make has to come in.
        vectorIndexCount: schema.vectorIndexes.length,
        // Voice-enabled agents (`defineAgent({ voice: … })`) → wire the worker's
        // `/_lunora/voice/<exportName>` route to each agent's `VOICE_*` DO
        // namespace. Empty for voice-free (and agent-free) projects, so the
        // emitted app.ts stays byte-identical.
        voiceAgents: agents
            .filter((agent) => agent.voice === true && agent.voiceBindingName !== undefined)
            .map((agent) => {
                return { bindingName: agent.voiceBindingName as string, exportName: agent.exportName };
            }),
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

    const schemaSnapshotPath = join(lunoraDirectory, SCHEMA_SNAPSHOT_FILENAME);
    const schemaSnapshotExists = existsSync(schemaSnapshotPath);

    if (!options.dryRun) {
        if (!existsSync(outputDirectory)) {
            mkdirSync(outputDirectory, { recursive: true });
        }

        writeIfChanged(join(outputDirectory, "app.ts"), appContent);
        writeIfChanged(dataModelPath, dataModelContent);
        writeIfChanged(join(outputDirectory, "api.ts"), apiContent);
        writeIfChanged(serverPath, serverContent);
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
        //   - agents.ts      → `@lunora/agent`, when agents are declared
        writeIfPresent(join(outputDirectory, "agents.ts"), agentsContent);
        writeIfPresent(join(outputDirectory, "queues.ts"), queuesContent);
        writeIfPresent(join(outputDirectory, "seed.ts"), seedContent);
        //   - collections.ts → `@lunora/db`, when the project declares shapes
        writeIfPresent(join(outputDirectory, "collections.ts"), collectionsContent);

        // The `.json` is the portable artifact for external tooling; the `.ts`
        // (same document, inlined) is what the worker imports and passes to
        // `createWorker({ openApiSpec })`. Both are gated on the same `apiSpec`
        // choice so they regenerate together — and routed through `writeIfPresent`
        // (empty content when the mode is off) so switching `apiSpec` away from a
        // format also DELETES its now-stale spec files instead of leaving a
        // portable artifact that documents endpoints/args that no longer exist.
        writeIfPresent(join(outputDirectory, "openapi.json"), wantsOpenApi ? openApiContent : "");
        writeIfPresent(join(outputDirectory, "openapi.ts"), wantsOpenApi ? openApiModuleContent : "");
        writeIfPresent(join(outputDirectory, "openrpc.json"), wantsOpenRpc ? openRpcContent : "");
        writeIfPresent(join(outputDirectory, "openrpc.ts"), wantsOpenRpc ? openRpcModuleContent : "");

        // Bless the schema baseline on first capture (so a project gets a
        // committed snapshot the moment it runs codegen) or when explicitly
        // asked to refresh it. The CLI gate reads the existing baseline BEFORE
        // calling codegen, so re-blessing here never hides drift from that run.
        if (!schemaSnapshotExists || options.updateSchemaBaseline === true) {
            writeIfChanged(schemaSnapshotPath, serializeSchemaSnapshot(schemaSnapshot));
        }
    }

    if (timingEnabled) {
        const finishedAt = performance.now();
        const total = Math.round(finishedAt - startedAt);
        const discovery = Math.round(emitStartedAt - startedAt);
        const emit = Math.round(finishedAt - emitStartedAt);

        // Diagnostic-only; stderr keeps it out of any stdout the caller parses.
        // eslint-disable-next-line no-console -- opt-in diagnostic line, gated on LUNORA_CODEGEN_TIMING
        console.error(`@lunora/codegen: codegen took ${total.toString()}ms (discovery ${discovery.toString()}ms, emit ${emit.toString()}ms)`);
    }

    return {
        advisories,
        advisorContext,
        agents,
        containers,
        cronTriggers: emitWranglerCronTriggers(crons),
        generated: {
            agents: agentsContent,
            api: apiContent,
            app: appContent,
            collections: collectionsContent,
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
            queues: queuesContent,
            seed: seedContent,
            server: serverContent,
            shard: shardContent,
            vectors: vectorsContent,
            workflows: workflowsContent,
        },
        migrations,
        outputDirectory,
        platformDiagnostics: platformGate.diagnostics,
        queues,
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
     * The deploy target codegen tailors the emitted `ctx.*` surface to.
     * Defaults to `"cloudflare"` — whose capability matrix marks every feature
     * native or emulated, so the default output is unchanged (byte-identical
     * goldens). A target that marks a used feature unsupported omits its
     * `ctx.*` surface and reports it in {@link CodegenResult.platformDiagnostics}.
     * Only `"cloudflare"` is registered until other per-target `@lunora/platform`
     * matrices land; an unknown target emits the full surface un-gated and a
     * `platform_unknown_target` diagnostic.
     */
    target?: string;

    /**
     * Re-bless the committed schema-drift baseline (`lunora/.lunora-schema.json`)
     * with the current structural snapshot. The baseline is ALWAYS written on
     * first capture (when the file is absent); set this to overwrite an existing
     * one — e.g. after the developer has added the data migration that justifies
     * a breaking change. Ignored when `dryRun` is true.
     */
    updateSchemaBaseline?: boolean;

    /**
     * Committed `wrangler.jsonc` `vars` entries that hold plaintext secrets — the
     * `plaintext_secret_in_wrangler_vars` lint input. Produced by `@lunora/config`
     * (which reads `wrangler.jsonc`) and threaded through by the CLI / Vite plugin;
     * codegen only forwards it to the advisor. Absent when no wrangler config is
     * present or the caller doesn't scan it.
     */
    wranglerVariables?: ReadonlyArray<WranglerVariableIR>;
}

export interface CodegenResult {
    /**
     * The normalized advisor evidence the findings were produced from, so a
     * caller can score it into a health map (`scoreAdvisor`) without re-running
     * discovery. `undefined` under `lint: false`.
     *
     * Deliberately not scored here: the map carries a `generatedAt` stamp, and
     * codegen's result stays a pure function of the sources.
     */
    advisorContext?: LintContext;

    /**
     * Static schema advisor findings (e.g. unindexed foreign keys) produced
     * this run. Empty when `lint` is `false` or the schema is clean. Codegen
     * does not print these itself — each caller presents them through its own
     * channel (the CLI logger, the vite overlay, the studio Advisors table).
     * `formatAdvisories` is exported for a plain multi-line rendering.
     */
    advisories: ReadonlyArray<Finding>;

    /**
     * Agents discovered from `defineAgent` exports in `lunora/agents.ts` — the
     * list the config layer reconciles into wrangler's `workflows[]` array (an
     * agent compiles onto a Cloudflare Workflow). Agents are NOT Durable Objects,
     * so this adds no binding or migration. Empty when the project declares none.
     */
    agents: ReadonlyArray<AgentIR>;

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
        /** WorkflowEntrypoint classes for declared agents (`_generated/agents.ts`); `""` (and not written) when no agents are declared. */
        agents: string;
        api: string;
        /** Fluent worker-composition builder (`_generated/app.ts`) — `defineApp()`. Always written. */
        app: string;
        /** Partial-replication collection factories (`_generated/collections.ts`); `""` (and not written) unless the project declares shapes and installs `@lunora/db`. */
        collections: string;
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
        /** Push-consumer queue registry (`_generated/queues.ts`); `""` (and not written) when no push queues are declared. */
        queues: string;
        /** Project-bound seed client (`_generated/seed.ts`); `""` (and not written) when `@lunora/seed` is not a declared dependency. */
        seed: string;
        server: string;
        shard: string;
        /** Static vector-index registry (`_generated/vectors.ts`) — `LUNORA_VECTOR_INDEXES`. Empty array body when the schema declares none. */
        vectors: string;
        /** WorkflowEntrypoint classes (`_generated/workflows.ts`); `""` (and not written) when no workflows are declared. */
        workflows: string;
    };

    /**
     * Data migrations discovered from `defineMigration` exports under `lunora/`,
     * each with the table it iterates. The drift gate matches a NEW id against
     * its table so a backfill only excuses breaking drift on the table it
     * actually visits. Empty when the project declares none.
     */
    migrations: ReadonlyArray<MigrationIR>;
    outputDirectory: string;

    /**
     * Portability diagnostics for the requested {@link CodegenOptions.target}:
     * `ctx.*` features the app uses that the target does not support (omitted
     * from the emitted surface), or an unknown target. Empty for a
     * fully-supported app on the default Cloudflare target. Presentation is the
     * caller's job, like {@link CodegenResult.advisories}.
     */
    platformDiagnostics: ReadonlyArray<PlatformDiagnostic>;

    /**
     * Queues discovered from `defineQueue` exports in `lunora/queues.ts` — the
     * list the config layer reconciles into wrangler's `queues.producers[]` /
     * `queues.consumers[]`. Queues are NOT Durable Objects, so this adds no
     * binding or migration. Empty when the project declares no queues.
     */
    queues: ReadonlyArray<QueueIR>;

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
export { findTsconfig, SCHEMA_SNAPSHOT_FILENAME };
