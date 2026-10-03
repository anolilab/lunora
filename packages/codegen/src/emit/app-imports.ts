import type { IdentityIR } from "../ir";
import type { ResolvedAppOptions } from "./app-helpers";
import { hasEmailAgents, hasShardedTables } from "./app-helpers";

/**
 * The `defineIdentity(...)` contract import — a VALUE (not `import type`) so it
 * can be wired onto `options.identity` and actually validate at the runtime
 * trust boundary. Namespace form mirrors `server.ts` so an arbitrary export name
 * can never collide with a builder import. Empty when no contract is declared.
 */
const buildIdentityImports = (identity: IdentityIR | undefined): string[] => (identity ? [`import * as lunoraIdentityContract from "../identity.js";`] : []);

/** `@lunora/cloudflare-access` imports — `composeResolvers` only when `@lunora/auth` also wires a resolver to fall back to. */
const buildAccessImports = (hasAccess: boolean, hasAuth: boolean): string[] =>
    hasAccess
        ? [
              `import type { CreateAccessResolverOptions } from "@lunora/cloudflare-access";`,
              `import { createAccessResolver${hasAuth ? ", composeResolvers" : ""} } from "@lunora/cloudflare-access";`,
          ]
        : [];

/** KV-browser import — the zero-config env-scanning introspector factory backing `createWorker({ kvIntrospector })`. */
const buildKvImports = (hasKvIntrospector: boolean): string[] =>
    hasKvIntrospector ? [`import { createKvIntrospectorFromEnv } from "@lunora/bindings/kv";`] : [];

/**
 * Vector-browser import — the admin introspector factory backing
 * `createWorker({ vectorIntrospector })`. Its companion is the generated
 * `LUNORA_VECTOR_INDEXES` registry (Vectorize cannot enumerate indexes at
 * runtime, which is why `_generated/vectors.ts` exists at all), imported with
 * the other relative `_generated` modules below.
 */
const buildVectorImports = (hasVectors: boolean): string[] => (hasVectors ? [`import { createVectorAdminIntrospector } from "@lunora/bindings/vectors";`] : []);

/** `@lunora/d1` imports for a D1-backed `.global()` app — the store factory, the admin/introspection helpers, and the retrying exec. */
const buildGlobalImports = (hasGlobal: boolean): string[] =>
    hasGlobal
        ? [
              `import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@lunora/d1";`,
              `import { applyCdcChanges, createD1CtxDb, emitD1QueryCost, exportGlobalRows, facetGlobalColumn, importGlobalRows, listGlobalTables, readD1CdcChanges, readGlobalTablePage, retryingExec } from "@lunora/d1";`,
          ]
        : [];

/** `lunora/notify.ts` default-export import — the `defineNotify(...)` config the worker reads its subscription store off (`createWorker({ notifySubscriptionStore })`). */
const buildNotifyImports = (hasNotify: boolean): string[] => (hasNotify ? [`import notifyConfig from "../notify.js";`] : []);

/**
 * Inbound-email wiring imports: the `dispatchAgentEmail` factory (a VALUE from
 * `@lunora/agent/inbound`) and the agent definitions as a namespace (so their
 * `onEmail` mappers are reachable at runtime). Empty when no `onEmail` agent is
 * declared, keeping email-free output byte-identical. `@lunora/agent` is an
 * opt-in add-on the umbrella never re-exports, so this is unconditionally
 * `@lunora/agent/inbound` regardless of `useUmbrella`.
 */
const buildInboundImports = (options: ResolvedAppOptions): string[] =>
    hasEmailAgents(options) ? [`import { dispatchAgentEmail } from "@lunora/agent/inbound";`] : [];

/**
 * The agent-definitions namespace import — `import * as lunoraAgentDefinitions
 * from "../agents.js"` — so each `onEmail` agent's mapper is reachable when the
 * generated `email()` handler dispatches. Empty (byte-identical output) when no
 * `onEmail` agent is declared.
 */
const buildAgentDefinitionsImport = (options: ResolvedAppOptions): string[] =>
    hasEmailAgents(options) ? [`import * as lunoraAgentDefinitions from "../agents.js";`] : [];

/**
 * The runtime module's own type and value import lines. Which symbols each side
 * needs is driven entirely by the enabled capabilities, so it is kept next to
 * the other per-capability builders rather than inline in {@link buildImportLines}.
 */
const buildRuntimeImports = (options: ResolvedAppOptions): string[] => {
    const { hasFramework, hasGlobal, hasHyperdriveGlobal, hasQueue, useUmbrella } = options;
    const runtimeModule = useUmbrella ? "lunorash/runtime" : "@lunora/runtime";

    const runtimeTypeImports = [
        "ExecutionContextLike",
        "HttpRouterLike",
        "LunoraWorker",
        "Route",
        "ScheduledControllerLike",
        "ShardNamespaceLike",
        "WorkerOptions",
        // The queue consumer's fourth argument — the trigger's own trace, forwarded
        // so a handler's `ctx.run` dispatches join it.
        ...(hasQueue ? ["TriggerTrace"] : []),
        ...(hasGlobal ? ["GlobalIntrospector"] : []),
        ...(options.tables.length > 0 ? ["ShardingInfo"] : []),
        ...(hasFramework ? ["FrameworkHostHandler"] : []),
    ];

    const runtimeValueImports = [
        ...(hasGlobal || hasHyperdriveGlobal ? ["createCrossShardRelationCapabilities"] : []),
        ...(hasShardedTables(options) ? ["createDynamicShardRegistry", "createQueryCoordinator"] : []),
        "createWorker",
        ...(options.jurisdiction ? ["declareAppJurisdiction"] : []),
        "resolveLogArchiveFromEnv",
        ...(hasFramework ? ["withFrameworkWorker"] : []),
    ].join(", ");

    return [
        `import type { ${[...runtimeTypeImports].toSorted((a, b) => a.localeCompare(b)).join(", ")} } from "${runtimeModule}";`,
        `import { ${runtimeValueImports} } from "${runtimeModule}";`,
    ];
};

/** Import lines — only what the enabled capabilities need. Add-ons via `@lunora/*`; the runtime via the umbrella subpath when the app depends on `lunora`. */
const buildImportLines = (options: ResolvedAppOptions): string[] => {
    const {
        hasAccess,
        hasAuth,
        hasGlobal,
        hasHyperdriveGlobal,
        hasKvIntrospector,
        hasQueue,
        hasScheduler,
        hasStorage,
        hasWorkflow,
        wantsOpenApi,
        wantsOpenRpc,
    } = options;
    return [
        ...(hasAuth
            ? [
                  `import type { AuthNamespaceLike, LunoraAuth, LunoraAuthOptions } from "@lunora/auth";`,
                  `import { authDiscoveryPathsFor, createAuth, createAuthAdmin, createAuthAuditReader, createDoAuthWiring, d1Executor, ensureMigrated, handleAuthDiscoveryRequest, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";`,
              ]
            : []),
        ...buildAccessImports(hasAccess, hasAuth),
        ...buildGlobalImports(hasGlobal),
        ...(hasHyperdriveGlobal
            ? [
                  `import type { HyperdriveEngine } from "@lunora/hyperdrive/global";`,
                  `import { createHyperdriveGlobalCtxDb } from "@lunora/hyperdrive/global";`,
                  `import type { SqlCtxDbOptions, SqlExec } from "@lunora/sql-store";`,
              ]
            : []),
        ...buildKvImports(hasKvIntrospector),
        ...buildVectorImports(options.hasVectors),
        ...(hasScheduler
            ? [`import type { DurableObjectNamespaceLike } from "@lunora/scheduler";`, `import { createScheduler } from "@lunora/scheduler";`]
            : []),
        ...(hasStorage
            ? [
                  `import type { R2BucketLike, R2S3Credentials, Storage } from "@lunora/storage";`,
                  `import { createBucketStorage, createStorage } from "@lunora/storage";`,
              ]
            : []),
        ...(hasWorkflow ? [`import { createWorkflowsRestClient } from "@lunora/workflow";`] : []),
        ...buildInboundImports(options),
        ...buildRuntimeImports(options),
        ``,
        ...buildIdentityImports(options.identity),
        ...buildAgentDefinitionsImport(options),
        ...(hasGlobal || hasHyperdriveGlobal ? [`import schema from "../schema.js";`] : []),
        ...buildNotifyImports(options.hasNotify),
        `import { LUNORA_CRONS } from "./crons.js";`,
        `import { LUNORA_FUNCTIONS } from "./functions.js";`,
        ...(hasQueue
            ? [
                  `import { createQueueCaptureSink, dispatchQueueBatch, shouldCaptureQueue } from "@lunora/queue";`,
                  `import { LUNORA_QUEUE_REGISTRY } from "./queues.js";`,
              ]
            : []),
        ...(options.wantsArchitecture ? [`import { architecture } from "./architecture.js";`] : []),
        ...(wantsOpenApi ? [`import { openApiSpec } from "./openapi.js";`] : []),
        ...(wantsOpenRpc ? [`import { openRpcSpec } from "./openrpc.js";`] : []),
        `import { createShardDO } from "./shard.js";`,
        ...(options.hasVectors ? [`import { LUNORA_VECTOR_INDEXES } from "./vectors.js";`] : []),
    ];
};

export default buildImportLines;
