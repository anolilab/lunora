import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { Finding } from "@lunora/advisor";
import { LunoraError } from "@lunora/errors";
import { Project } from "ts-morph";

import type { SchemaSnapshot } from "../../../shared/schema-snapshot";
import { serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
import { lintSchema } from "./advisor";
import discoverAdminRoutes from "./discover-admin-routes";
import { discoverAgents } from "./discover-agents";
import discoverAiRawRuns from "./discover-ai-raw-runs";
import discoverAiToolSideEffects from "./discover-ai-tool-side-effects";
import discoverArgumentDerivedFetches from "./discover-argument-derived-fetches";
import discoverArgumentValidators from "./discover-argument-validators";
import discoverAuthConfig from "./discover-auth-config";
import discoverAuthApiCalls from "./discover-authapi-calls";
import discoverBrowserUrlAccesses from "./discover-browser-url-accesses";
import discoverConfigCalls from "./discover-config-calls";
import discoverContainerKeyAccesses from "./discover-container-key-accesses";
import discoverContainerOverrides from "./discover-container-overrides";
import { discoverContainers } from "./discover-containers";
import discoverCrons from "./discover-crons";
import { discoverEnv } from "./discover-env";
import discoverExportSinks from "./discover-export-sinks";
import discoverFailOpenGuards from "./discover-fail-open-guards";
import { buildStudioFeatures, discoverFeatureUsage, hasPaymentStoreTables } from "./discover-feature-usage";
import discoverFlagSecurityDefaults from "./discover-flag-security-defaults";
import { discoverFlagKeys } from "./discover-flags";
import { discoverFunctions, listLunoraSourceFiles } from "./discover-functions";
import discoverGeoIndexUsages from "./discover-geo-index-usages";
import discoverHttpActionGuards from "./discover-http-action-guards";
import discoverHttpHeaderWrites from "./discover-http-header-writes";
import discoverHttpRoutes from "./discover-http-routes";
import { discoverIdentity } from "./discover-identity";
import discoverIdentityClaimReads from "./discover-identity-claim-reads";
import discoverImageDeliveryUrlAccesses from "./discover-image-delivery-url-accesses";
import discoverInserts from "./discover-inserts";
import discoverKvKeyAccesses from "./discover-kv-key-accesses";
import discoverMailRecipientAccesses from "./discover-mail-recipient-accesses";
import discoverMaskProcedures, { discoverMaskMetadata, discoverMaskStrategies } from "./discover-mask-procedures";
import discoverMigrations from "./discover-migrations";
import discoverMutatorWrites from "./discover-mutator-writes";
import { discoverMutators } from "./discover-mutators";
import discoverNondeterministicCalls from "./discover-nondeterministic-calls";
import discoverNormalizeIdAuthorization from "./discover-normalize-id-authorization";
import { discoverNotifyCalls, discoverNotifyConfig } from "./discover-notify";
import discoverOwnerFieldWrites from "./discover-owner-field-writes";
import discoverPackageDependencies from "./discover-package-dependencies";
import discoverPaymentWebhooks from "./discover-payment-webhooks";
import discoverPrivilegedDispatches from "./discover-privileged-dispatches";
import discoverProcedureMiddleware from "./discover-procedure-middleware";
import discoverQueries from "./discover-queries";
import { discoverQueues } from "./discover-queues";
import discoverR2sqlCalls from "./discover-r2sql-calls";
import discoverRatelimitKeySelectors from "./discover-ratelimit-key-selectors";
import discoverRawRowReturns from "./discover-raw-row-returns";
import discoverRelationLoads from "./discover-relation-loads";
import discoverRlsProcedures, { discoverRlsMetadata } from "./discover-rls-procedures";
import { discoverSandboxUsage } from "./discover-sandbox";
import discoverSchema from "./discover-schema";
import discoverSecrets from "./discover-secrets";
import { discoverShapes } from "./discover-shapes";
import discoverSoftDeleteReads from "./discover-soft-delete-reads";
import discoverSqlInterpolation from "./discover-sql-interpolation";
import discoverStorageKeyAccesses from "./discover-storage-key-accesses";
import discoverStorageRulesMetadata from "./discover-storage-rules";
import discoverStorageUploads from "./discover-storage-uploads";
import discoverUnrestrictedWhereBranches from "./discover-unrestricted-where-branches";
import discoverVectorNamespaceAccesses from "./discover-vector-namespace-accesses";
import discoverWorkflowCalls from "./discover-workflow-calls";
import { discoverWorkflows } from "./discover-workflows";
import {
    buildStorageColumns,
    emitAgents,
    emitApi,
    emitCollections,
    emitContainers,
    emitCrons,
    emitDataModel,
    emitDrizzleSchema,
    emitFunctions,
    emitQueues,
    emitSeed,
    emitServer,
    emitShard,
    emitVectors,
    emitWorkflows,
    emitWranglerCronTriggers,
} from "./emit";
import { emitApp } from "./emit-app";
import type { AgentIR, ContainerIR, QueueIR, WorkflowIR, WranglerVariableIR } from "./ir";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";
import type { PlatformDiagnostic } from "./platform-target";
import { gatePlatformFeatures, resolveCodegenTarget } from "./platform-target";
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
 * `@lunora/seed` uninstalled) would leave a lingering `_generated/&lt;feature>.ts`
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
 * Reject a workflow and an agent that share a deployed `name`, `bindingName`,
 * or generated `className`. `discoverWorkflows`/`discoverAgents` each guard
 * uniqueness WITHIN their own kind, but both kinds land in the exact same
 * wrangler `workflows[]` array (matched only by `class_name`/binding) — an
 * agent named like a workflow (or vice versa) passes both discoverers silently
 * and either fails late in wrangler or clobbers a binding at reconcile time.
 * The `className` check catches the case where the deployed `name`/`bindingName`
 * differ but the derived generated class collides — two implementations would
 * then compete for one worker export/`class_name`. Runs after both are
 * discovered, before reconcile ever sees them.
 */
const assertNoWorkflowAgentCollision = (workflows: ReadonlyArray<WorkflowIR>, agents: ReadonlyArray<AgentIR>): void => {
    const namesByLabel = new Map<string, string>();
    const bindingsByLabel = new Map<string, string>();
    const classesByLabel = new Map<string, string>();

    for (const workflow of workflows) {
        namesByLabel.set(workflow.name, `workflow "${workflow.exportName}"`);
        bindingsByLabel.set(workflow.bindingName, `workflow "${workflow.exportName}"`);
        classesByLabel.set(workflow.className, `workflow "${workflow.exportName}"`);
    }

    for (const agent of agents) {
        const priorName = namesByLabel.get(agent.name);

        if (priorName !== undefined) {
            throw new LunoraError(
                // eslint-disable-next-line no-secrets/no-secrets -- an error code, not a secret
                "DUPLICATE_WORKFLOW_NAME",
                `Duplicate deployed name "${agent.name}": produced by both ${priorName} and agent "${agent.exportName}". Workflow and agent names share the same wrangler workflows[] array and must be unique together.`,
                { status: 500 },
            );
        }

        const priorBinding = bindingsByLabel.get(agent.bindingName);

        if (priorBinding !== undefined) {
            throw new LunoraError(
                // eslint-disable-next-line no-secrets/no-secrets -- an error code, not a secret
                "DUPLICATE_WORKFLOW_BINDING",
                `Duplicate binding "${agent.bindingName}": produced by both ${priorBinding} and agent "${agent.exportName}". Workflow and agent bindings share the same wrangler workflows[] array and must be unique together.`,
                { status: 500 },
            );
        }

        const priorClass = classesByLabel.get(agent.className);

        if (priorClass !== undefined) {
            throw new LunoraError(
                "DUPLICATE_WORKFLOW_CLASS",
                `Duplicate generated class "${agent.className}": produced by both ${priorClass} and agent "${agent.exportName}". Workflow and agent export names must yield unique generated class names.`,
                { status: 500 },
            );
        }
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

    const schema = discoverSchema(project, schemaPath, options.projectRoot);
    const functions = discoverFunctions(project, lunoraDirectory);
    const httpRoutes = discoverHttpRoutes(project, lunoraDirectory);
    const migrations = discoverMigrations(project, lunoraDirectory);

    // Local-first sync engine (Phase 7): replication shapes (`lunora/shapes.ts`)
    // and custom mutators (`lunora/mutators.ts`). Shapes gate the generated DO's
    // `resolveShape` override + the `_generated/collections.ts` factories;
    // mutators register into `LUNORA_FUNCTIONS` (transaction-wrapped) and the
    // `isCustomMutator` push-protocol override. Both return `[]` when their file
    // is absent, so a project without them emits byte-identical generated code.
    const shapes = discoverShapes(project, lunoraDirectory);
    const mutators = discoverMutators(project, lunoraDirectory);

    // Typed identity layer (Plan 080): the single `defineIdentity(...)` claim
    // contract declared in `lunora/identity.ts`. When present, `emitServer`
    // narrows `ctx.auth.getIdentity()`, the RLS policy `ctx.auth.identity`, and
    // the shard-authorization hooks to the declared shape. `undefined` when the
    // file is absent, so a project without one emits byte-identical server.ts.
    const identity = discoverIdentity(project, lunoraDirectory);

    // Typed env layer: the single `defineEnv(...)` contract declared in
    // `lunora/env.ts`. When present, `emitServer` types `ctx.env` as the
    // validated `InferEnv` shape and the generated ShardDO applies the accessor
    // to the worker `env` at ctx-build time. `undefined` when the file is absent,
    // so a project without one emits byte-identical generated code.
    const env = discoverEnv(project, lunoraDirectory);

    // Workflows declared via `defineWorkflow` exports in `lunora/workflows.ts`.
    // Discovered before crons so a `cronJobs()` registration can target a
    // workflow by its export name (the cron then starts a durable instance per
    // fire instead of dispatching a one-shot function).
    const workflows = discoverWorkflows(project, lunoraDirectory);
    // Queues declared via `defineQueue` exports in `lunora/queues.ts` — the typed
    // `ctx.queues` producers, the generated push-consumer registry
    // (`_generated/queues.ts` → the worker `queue()` dispatch), and the config
    // layer's wrangler `queues.producers[]` / `queues.consumers[]` reconciliation.
    const queues = discoverQueues(project, lunoraDirectory);
    // Agents declared via `defineAgent` exports in `lunora/agents.ts` — each
    // compiles onto a Cloudflare Workflow, so this drives `_generated/agents.ts`
    // (the agent WorkflowEntrypoint classes), the typed `ctx.agents` producers on
    // Mutation/Action contexts, and the config layer's reconciliation of the
    // wrangler `workflows[]` array (an agent binding is a Workflow binding).
    const agents = discoverAgents(project, lunoraDirectory);

    // Cross-kind guard: `discoverWorkflows`/`discoverAgents` each dedup WITHIN
    // their own kind, but both share the single wrangler `workflows[]` array —
    // a name/binding an agent and a workflow both produce must be rejected here,
    // before the config layer's reconciliation ever sees them.
    assertNoWorkflowAgentCollision(workflows, agents);

    const crons = discoverCrons(project, lunoraDirectory, workflows, agents);

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
            : lintSchema({
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
                  failOpenGuards: discoverFailOpenGuards(project, lunoraDirectory),
                  flagSecurityDefaults: discoverFlagSecurityDefaults(project, lunoraDirectory),
                  geoIndexUsages: discoverGeoIndexUsages(project, lunoraDirectory),
                  httpActionGuards: discoverHttpActionGuards(project, lunoraDirectory),
                  httpHeaderWrites: discoverHttpHeaderWrites(project, lunoraDirectory),
                  identityClaimReads: discoverIdentityClaimReads(project, lunoraDirectory),
                  imageDeliveryUrlAccesses: discoverImageDeliveryUrlAccesses(project, lunoraDirectory),
                  inserts: discoverInserts(project, lunoraDirectory),
                  kvKeyAccesses: discoverKvKeyAccesses(project, lunoraDirectory),
                  mailRecipientAccesses: discoverMailRecipientAccesses(project, lunoraDirectory),
                  maskProcedures: discoverMaskProcedures(project, lunoraDirectory),
                  maskStrategies: discoverMaskStrategies(project, lunoraDirectory),
                  mutatorWrites: discoverMutatorWrites(project, lunoraDirectory),
                  nondeterministicCalls: discoverNondeterministicCalls(project, lunoraDirectory),
                  normalizeIdAuthorizations: discoverNormalizeIdAuthorization(project, lunoraDirectory),
                  notifyCalls: discoverNotifyCalls(project, lunoraDirectory),
                  notifyConfig: discoverNotifyConfig(project, lunoraDirectory),
                  ownerFieldWrites: discoverOwnerFieldWrites(project, lunoraDirectory),
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
                  storageKeyAccesses: discoverStorageKeyAccesses(project, lunoraDirectory),
                  storageUploads: discoverStorageUploads(project, lunoraDirectory),
                  vectorNamespaceAccesses: discoverVectorNamespaceAccesses(project, lunoraDirectory),
                  workflowCalls: discoverWorkflowCalls(project, lunoraDirectory),
                  workflows,
                  wranglerVariables: options.wranglerVariables,
              });

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
    const rawFeatureUsage = discoverFeatureUsage(project, lunoraDirectory);
    // Intersect what the app uses with what the deploy target supports. For the
    // default Cloudflare target the matrix marks nothing unsupported, so the
    // gate is the identity and the emitted surface (and goldens) is unchanged;
    // a target that lacks a used feature omits its `ctx.*` surface below and
    // reports a `platform_unsupported_feature` diagnostic.
    // Resolved here rather than demanded of every caller: a call site that omits
    // the target emits the DEFAULT surface with no diagnostic, so the mismatch
    // stays invisible until the deployed app fails. Falling back to the
    // project's declared target makes every caller correct without remembering.
    const platformGate = gatePlatformFeatures(rawFeatureUsage, resolveCodegenTarget(options.projectRoot, options.target));
    const featureUsage = platformGate.usage;
    const hasAi = featureUsage.ai;
    const hasPayments = featureUsage.payments;
    // New Cloudflare-capability ctx augmentations (Plans 027/028/031/032/035/036).
    // These flip the emitted ctx type seam in `server.ts` (type-only dynamic
    // imports); the runtime ShardDO wiring lands with each capability's package.
    const hasKv = featureUsage.kv;
    // `ctx.access` — the verified Cloudflare Access identity facade, wired onto
    // every ctx when a `lunora/` source reads `ctx.access`. NB: distinct from the
    // `hasAccess` below (a declared `@lunora/cloudflare-access` dependency, which
    // gates the worker's `.access()` resolveIdentity builder method). The
    // `accessContext()` middleware imports the package's `/context` subpath, so it
    // never trips this usage probe — the two paths don't collide.
    const hasAccessFacade = featureUsage.access;
    // `ctx.flags` is gated on the project actually declaring a `lunora/flags.ts`
    // (`defineFlags(...)`) — the generated ShardDO imports that module's default
    // export for its OpenFeature provider, so wiring `ctx.flags` without it would
    // emit a broken import. (A handler reading `ctx.flags` without the module is a
    // compile error — the field is only typed when the module exists.)
    const hasFlags = existsSync(join(lunoraDirectory, "flags.ts"));
    // Statically-discovered `ctx.flags.<type>("key")` reads — the generated
    // ShardDO's `evaluateFlags` (studio Flags page) + the reactive read override
    // (`useFlag`) iterate these. Only meaningful when a provider is wired.
    const flagKeys = hasFlags ? discoverFlagKeys(project, lunoraDirectory) : [];
    // `ctx.notify` + its `ctx.push` alias (`@lunora/notify`) is gated on the
    // project declaring a `lunora/notify.ts` (`defineNotify(...)`), mirroring
    // `hasFlags`: the generated ShardDO imports that module's default export to
    // build both facades via `createNotify(notifyConfig, env)`, so wiring the ctx
    // fields without it would emit a broken import. Notify rides EVERY ctx (like
    // `ctx.flags`); the `notify_send_outside_action` lint — not the type — keeps
    // non-deterministic sends out of query/mutation handlers.
    const hasNotify = existsSync(join(lunoraDirectory, "notify.ts"));
    const hasHyperdrive = featureUsage.hyperdrive;
    // Batteries-included sandbox tools (`@lunora/agent/sandbox`). `browserTool`
    // drives `ctx.browser`, so it flips `hasBrowser` (provisioning the BROWSER
    // binding + wiring `ctx.browser` onto the action ctx the dispatcher runs on);
    // either tool registers the `sandbox:invoke` dispatcher via `emitFunctions`.
    const sandboxUsage = discoverSandboxUsage(project, lunoraDirectory);
    const usesSandbox = sandboxUsage.usesSandboxBrowser || sandboxUsage.usesSandboxContainer;
    const hasBrowser = featureUsage.browser || sandboxUsage.usesSandboxBrowser;
    const hasImages = featureUsage.images;
    const hasAnalytics = featureUsage.analytics;
    const hasPipelines = featureUsage.pipelines;
    const hasR2sql = featureUsage.r2sql;
    const hasX402 = featureUsage.x402;

    // Which optional, package-backed features the studio should show a nav page
    // for. `buildStudioFeatures` OR's the code-usage flags with the schema/project
    // signals the `lunora/`-scoped scan can't see: storage columns + access rules,
    // declared crons, vector indexes, and — crucially for packages wired only in
    // the worker entry (e.g. `@lunora/mail`) — the project's declared dependencies.
    // Emitted into the generated ShardDO's `studioFeatures()` override so the
    // studio hides only pages whose backing package the app genuinely never wires.
    const dependencies = discoverPackageDependencies(options.projectRoot);
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
        workflowCount: workflows.length,
    });

    // When the project depends on the `lunora` umbrella (instead of the granular
    // `@lunora/*` base packages), the generated files import the base surface
    // through the umbrella's subpaths (`lunorash/server`, `lunorash/do`, …) so the
    // app needs only the single `lunorash` dependency installed.
    const useUmbrella = dependencies.has("lunorash");

    // Boundary between the discovery phase (all `discover*` passes + the inline
    // discovers `lintSchema` drives + the metadata discovers above) and the emit
    // phase (the `emit*`/`build*`/serialize work + the file writes below).
    const emitStartedAt = timingEnabled ? performance.now() : 0;

    const dataModelContent = emitDataModel(schema, useUmbrella);
    const apiContent = emitApi({ agents, functions, httpRoutes, mutators, useUmbrella, workflows });
    const serverContent = emitServer({
        agents,
        containers,
        env,
        hasAccessFacade,
        hasAi,
        hasAnalytics,
        hasBrowser,
        hasFlags,
        hasHyperdrive,
        hasImages,
        hasKv,
        hasNotify,
        hasPayments,
        hasPipelines,
        hasR2sql,
        hasX402,
        identity,
        queues,
        schema,
        storageRuleBuckets: storageRulesMetadata.rules.map((rule) => rule.bucket),
        useUmbrella,
        workflows,
    });
    const functionsContent = emitFunctions({ agents, functions, migrations, mutators, shapes, useUmbrella, usesSandbox });
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
        agents,
        containers,
        env,
        flagKeys,
        hasAccessFacade,
        hasAi,
        hasAnalytics,
        hasBrowser,
        hasFlags,
        hasHyperdrive,
        hasImages,
        hasKv,
        hasNotify,
        hasPayments,
        hasPipelines,
        hasR2sql,
        hasX402,
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
        // Auto-wire the studio's KV introspector on the SAME condition the nav
        // gates its tab on (`studioFeatures.kv` = ctx.kv usage OR a declared
        // `@lunora/bindings/kv` dep), so a visible KV tab always has a working
        // backend — never the reverse. The `ctx.kv` type-seam stays usage-only.
        hasKv: studioFeatures.kv,
        hasNotify,
        hasPayments,
        hasR2sql,
        hasQueue: queues.some((queue) => queue.mode === "push"),
        hasScheduler: studioFeatures.scheduler,
        hasStorage: studioFeatures.storage,
        hasVectors: schema.vectorIndexes.length > 0,
        hasWorkflow: workflows.length > 0,
        hasX402,
        // The single `defineIdentity(...)` contract (Plan 080). Wires
        // `options.identity` so the runtime trust boundary validates every
        // resolved identity before it becomes `ctx.auth`; `undefined` keeps the
        // emitted app.ts byte-identical to before this feature.
        identity,
        // Schema `.jurisdiction("…")` → pin the generated worker's DOs to the region.
        jurisdiction: schema.jurisdiction,
        useUmbrella,
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
export { SCHEMA_SNAPSHOT_FILENAME };
