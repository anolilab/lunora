/**
 * The first phase of a codegen run: everything that must be known — and
 * rendered — before a single handler's type is inferred.
 *
 * # Why this is a phase and not just the top of `runCodegen`
 *
 * `discoverFunctions` reads each handler's return type out of the ts-morph
 * `Project` as it stands at that moment. Every type a handler can name resolves
 * through `dataModel.ts` (`Doc`/`Id`) or `server.ts` (the schema-typed `ctx.db`
 * and its paginated results), so whichever version of those two files the
 * project happens to hold is what inference sees. Render them late and pass 1
 * infers against the PREVIOUS run's declarations — a table added this run has no
 * `Doc`, the return collapses to `unknown`, and the collapse is written into
 * `api.ts`. The tree then only converges on a second `lunora codegen`, which is
 * what pushes projects into wrapping the CLI in a
 * run-until-the-hash-stops-changing loop (issue #283).
 *
 * So the ordering constraint is real and load-bearing, and it is why this
 * boundary exists: everything here happens strictly before inference, and
 * nothing here may depend on it. That second half is what makes the split safe —
 * none of `emitServer`'s inputs was ever derived from the discovered functions,
 * they were merely computed further down the file.
 *
 * # What it deliberately does not do
 *
 * It does not WRITE. The rendered files reach the ts-morph project in memory and
 * nothing else, because a run can still throw between here and the write phase
 * (`assertNoMaskedShapeTable`, a parse error in a handler) — and a new
 * `dataModel.ts` committed beside a stale `api.ts` is worse than no output,
 * especially on a table removal, where `Doc_x` disappears while every file
 * referencing it stays.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { Project } from "ts-morph";

import assertRequiredPackages from "./assert-required-packages";
import { discoverAgents } from "./discover/agents";
import { discoverContainers } from "./discover/containers";
import discoverCrons from "./discover/crons";
import { discoverEnv } from "./discover/env";
import type { FeatureUsage } from "./discover/feature-usage";
import { discoverFeatureUsage } from "./discover/feature-usage";
import { discoverIdentity } from "./discover/identity";
import readPackageDependencies from "./discover/package-dependencies";
import { discoverPlatformSignals } from "./discover/platform-signals";
import { discoverQueues } from "./discover/queues";
import { discoverSandboxUsage } from "./discover/sandbox";
import discoverStorageRulesMetadata from "./discover/storage-rules";
import { discoverWorkflows } from "./discover/workflows";
import { emitDataModel, emitServer } from "./emit";
import type { AgentIR, ContainerIR, CronJobIR, EnvIR, IdentityIR, QueueIR, SchemaIR, StorageRulesMetadataIR, WorkflowIR } from "./ir";
import type { PlatformGateResult } from "./platform-target";
import { gatePlatformFeatures, resolveCodegenTarget } from "./platform-target";

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
 * Everything the phase resolved, for the rest of the run to read.
 *
 * The per-capability booleans that used to sit here — `hasAi`, `hasKv`,
 * `hasPayments`, and nine more — are gone: each was a verbatim restatement of
 * `featureUsage` keyed by capability, so call sites read that map directly. Only the two
 * whose value is NOT a plain capability read survive as their own fields, and
 * each says why below. `hasBrowser` was a third until `browserTool` usage moved
 * INTO the gate's input, where it belongs — it is `featureUsage.browser` now.
 */
interface DeclarationSurface {
    agents: ReadonlyArray<AgentIR>;
    containers: ReadonlyArray<ContainerIR>;
    /** Cron jobs discovered from `cronJobs()` registrations — read by the platform gate here, emitted downstream. */
    crons: ReadonlyArray<CronJobIR>;
    /** `_generated/dataModel.ts`, rendered. Not written — see the module docblock. */
    dataModelContent: string;
    /** Declared dependency names, or `undefined` when the manifest is absent/unreadable. */
    declaredDependencies: ReadonlySet<string> | undefined;
    /** The same names with the absent case flattened to an empty set. */
    dependencies: ReadonlySet<string>;
    env: EnvIR | undefined;

    /**
     * Code-usage flags, already intersected with the deploy target's capability
     * matrix. Read the capability off this map at the point of use rather than
     * through a local alias — the alias layer was pure restatement.
     */
    featureUsage: FeatureUsage;

    /**
     * `ctx.flags`. Gated on the project declaring `lunora/flags.ts`, NOT on
     * `featureUsage.flags`: the generated ShardDO imports that module's default
     * export for its OpenFeature provider, so wiring the ctx without the module
     * present would emit a broken import. (A handler reading `ctx.flags` without
     * it is a compile error — the field is only typed when the module exists.)
     */
    hasFlags: boolean;

    /**
     * `ctx.notify` and its `ctx.push` alias. Gated on `lunora/notify.ts` for the
     * same reason `hasFlags` is — the ShardDO imports the module's default
     * export to build both facades via `createNotify(notifyConfig, env)`. Notify
     * rides EVERY ctx; the `notify_send_outside_action` lint, not the type, keeps
     * non-deterministic sends out of query/mutation handlers.
     */
    hasNotify: boolean;
    identity: IdentityIR | undefined;
    /** Carries the portability diagnostics; `usage` is already unpacked as the `featureUsage` field. */
    platformGate: PlatformGateResult;
    queues: ReadonlyArray<QueueIR>;
    /** `_generated/server.ts`, rendered. Not written — see the module docblock. */
    serverContent: string;
    storageRulesMetadata: StorageRulesMetadataIR;
    /** Either sandbox tool registers the `sandbox:invoke` dispatcher via `emitFunctions`. */
    usesSandbox: boolean;
    /** The project depends on the `lunorash` umbrella, so generated files import through its subpaths. */
    useUmbrella: boolean;
    workflows: ReadonlyArray<WorkflowIR>;
}

interface DeclarationSurfaceOptions {
    lunoraDirectory: string;
    project: Project;
    projectRoot: string;
    schema: SchemaIR;
    /** The deploy target the emitted `ctx.*` surface is tailored to. */
    target?: string;
}

/**
 * Discover and render the declaration surface.
 *
 * Order within the phase matters in two places and nowhere else: workflows and
 * agents are discovered before {@link assertNoWorkflowAgentCollision} rejects a
 * name they share, and `assertRequiredPackages` runs before either file is
 * rendered so a missing add-on fails as an actionable error rather than as `tsc`
 * output inside a generated file.
 * @param options The project to read and the schema already discovered from it.
 * @returns the resolved facts plus the two rendered files.
 */
const buildDeclarationSurface = (options: DeclarationSurfaceOptions): DeclarationSurface => {
    const { lunoraDirectory, project, projectRoot, schema } = options;

    const identity = discoverIdentity(project, lunoraDirectory);
    const env = discoverEnv(project, lunoraDirectory);

    // Workflows before agents before the collision guard: each discoverer dedups
    // only within its own kind, but both land in one wrangler `workflows[]`.
    const workflows = discoverWorkflows(project, lunoraDirectory);
    const queues = discoverQueues(project, lunoraDirectory);
    const agents = discoverAgents(project, lunoraDirectory);

    assertNoWorkflowAgentCollision(workflows, agents);

    const containers = discoverContainers(project, lunoraDirectory);
    const storageRulesMetadata = discoverStorageRulesMetadata(project, lunoraDirectory);

    // Crons are discovered here, beside the workflows and agents they resolve
    // their targets against, rather than after inference: the platform gate below
    // has to see a declared cron, and it runs in this phase. Resolution is purely
    // syntactic (`internal.file.fn` / `workflows.NAME` / `agents.NAME`) and reads
    // nothing from `_generated/`, which `listLunoraSourceFiles` skips, so moving
    // it earlier cannot change what it finds.
    const crons = discoverCrons(project, lunoraDirectory, workflows, agents);

    // Intersect what the app uses with what the deploy target supports. For the
    // default Cloudflare target the matrix marks nothing unsupported, so the gate
    // is the identity and the emitted surface (and goldens) is unchanged; a target
    // that lacks a used feature omits its `ctx.*` surface and reports a
    // `platform_unsupported_feature` diagnostic.
    //
    // The target is resolved here rather than demanded of every caller: a call
    // site that omits it would emit the DEFAULT surface with no diagnostic, so the
    // mismatch would stay invisible until the deployed app failed.
    //
    // Beyond the `ctx.*` capability keys, the gate also takes the app-declarable
    // features that have no capability row — a `.global()` table, a
    // `defineQueue`, a `.shardBy(...)` schema, a durable `.stream()`, a
    // `ctx.secrets` read, a declared cron, a `.vectorize()` index, a
    // `defineAgent` export. Those are rated in every capability matrix and were
    // consulted by nothing, so e.g. a durable stream on `target: "node"` emitted
    // its full surface and silently behaved as ephemeral, and a declared cron
    // built green on a host where no runtime dispatches one.
    const codeSignals = discoverPlatformSignals(project, lunoraDirectory);
    const sandboxUsage = discoverSandboxUsage(project, lunoraDirectory);
    const usage = discoverFeatureUsage(project, lunoraDirectory);

    // `@lunora/agent`'s `browserTool` drives `ctx.browser` too, so it is browser
    // USAGE and has to enter the gate as such. Folded in here rather than OR'd
    // onto the gate's output downstream, which is where it used to live: that OR
    // ran after the gate had already turned `browser` off, so importing the tool
    // both suppressed the diagnostic and re-emitted the surface — and provisioned
    // the BROWSER binding — on a target with no headless browser at all.
    usage.browser = usage.browser || sandboxUsage.usesSandboxBrowser;

    const platformGate = gatePlatformFeatures(usage, resolveCodegenTarget(projectRoot, options.target), {
        // An agent needs both a workflow engine to mount its generated class and
        // model inference to run its loop, which is why it is rated on its own
        // key rather than inherited from `workflows`.
        agents: agents.length > 0,
        // Read off the SAME IR as `globalTables` below. Until this was wired, a
        // target whose matrix rates `commitOrderedTables` as `unsupported` emitted
        // the full surface and silently dropped the ordering guarantee.
        commitOrderedTables: schema.tables.some((table) => table.commitOrdered === true),
        // Declared crons, not `ctx.scheduler` usage: `cronJobs` is imported from
        // `@lunora/server`, so the `featureUsage` arm (which keys `scheduler` on
        // a `@lunora/scheduler` import) cannot see one.
        cronTriggers: crons.length > 0,
        crossShardFanout: schema.tables.some((table) => typeof table.shardMode === "object"),
        durableStreams: codeSignals.durableStreams,
        globalTables: schema.tables.some((table) => table.shardMode === "global"),
        queues: queues.length > 0,
        secrets: codeSignals.secrets,
        // Read off the schema for the same reason `globalTables` is — and it has
        // to be, because `ctx.vectors` is emitted off `schema.vectorIndexes`
        // while the `vectors` capability only flips on an import or a literal
        // `ctx.vectors` read, neither of which a `.vectorize()` declaration is.
        vectorStore: schema.vectorIndexes.length > 0,
    });
    const featureUsage = platformGate.usage;
    // The gate's `vectorStore` verdict, named once for both consumers below.
    // `undefined` means the app never declared a vector index, which must not
    // withhold anything; only an explicit `false` is a rejection.
    const vectorStoreSupported = platformGate.signals.vectorStore !== false;

    const declaredDependencies = readPackageDependencies(projectRoot);
    const dependencies = declaredDependencies ?? new Set<string>();
    const useUmbrella = dependencies.has("lunorash");

    // Before either render: a schema needing an uninstalled add-on must fail as an
    // actionable error naming the package, not as a `tsc` failure reported inside
    // a generated file the user did not write.
    assertRequiredPackages(schema, declaredDependencies, vectorStoreSupported);

    const hasFlags = existsSync(join(lunoraDirectory, "flags.ts"));
    const hasNotify = existsSync(join(lunoraDirectory, "notify.ts"));

    return {
        agents,
        containers,
        crons,
        dataModelContent: emitDataModel(schema),
        declaredDependencies,
        dependencies,
        env,
        featureUsage,
        hasFlags,
        hasNotify,
        identity,
        platformGate,
        queues,
        serverContent: emitServer({
            agents,
            containers,
            env,
            hasAccessFacade: featureUsage.access,
            hasAi: featureUsage.ai,
            hasAnalytics: featureUsage.analytics,
            hasBrowser: featureUsage.browser,
            // The gate's verdict, not the raw declaration: a `.vectorize()` column
            // declares the feature without importing anything, so `featureUsage`
            // never sees it. The emitter AND's it with `schema.vectorIndexes`.
            hasVectors: vectorStoreSupported,
            hasFlags,
            hasHyperdrive: featureUsage.hyperdrive,
            hasImages: featureUsage.images,
            hasKv: featureUsage.kv,
            hasNotify,
            hasPayments: featureUsage.payments,
            hasPipelines: featureUsage.pipelines,
            hasR2sql: featureUsage.r2sql,
            hasX402: featureUsage.x402,
            identity,
            queues,
            schema,
            storageRuleBuckets: storageRulesMetadata.rules.map((rule) => rule.bucket),
            useUmbrella,
            workflows,
        }),
        storageRulesMetadata,
        // ANY sandbox tool needs the `sandbox:invoke` dispatcher registered — the
        // receiver's `fs` arm is as unreachable without it as the browser one.
        usesSandbox: sandboxUsage.usesSandboxBrowser || sandboxUsage.usesSandboxContainer || sandboxUsage.usesSandboxFs,
        useUmbrella,
        workflows,
    };
};

export { buildDeclarationSurface };
export type { DeclarationSurface, DeclarationSurfaceOptions };
