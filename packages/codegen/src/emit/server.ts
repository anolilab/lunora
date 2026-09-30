import { LunoraError } from "@lunora/errors";

import type { CapabilityKey, CapabilityTier } from "../capabilities";
import { SERVER_CTX_FIELDS } from "../capabilities";
import type { AgentIR, ContainerIR, EnvIR, IdentityIR, QueueIR, SchemaIR, WorkflowIR } from "../ir";
import { assertIdentifier, baseSpecifiers, GENERATED_HEADER, unwrapOptional } from "./shared";

/**
 * Emit `_generated/server.ts` — re-exports of the user-facing factories
 * (`query`/`mutation`/`action`/`v` and the project-typed contexts).
 *
 * **This file must never import the user's function modules.** User code
 * imports `v`/`query`/`mutation` from here, so if `server.ts` imported the
 * function modules back, we'd form a cycle: the function module's top-level
 * `mutation({ args: { x: v.string() } })` would run while `server.ts`'s
 * `export const v = …` is still uninitialized, and `v` would read as
 * `undefined` (TypeError: reading 'string'). The dispatch table that *does*
 * import every function module lives in `_generated/functions.ts` instead.
 */

/**
 * Distinct bucket names the schema declares — `"default"` (the unnamed bucket)
 * plus every `v.storage("name")` column bucket and every bucket named in a
 * `defineStorageRule({ bucket })`. Drives the generated `StorageBucketName` union
 * so `ctx.storage.bucket(name)` is autocompleted + checked (and a rule's bucket
 * is reachable even when no column references it). Sorted, `"default"` first.
 *
 * **This union is an autocomplete aid, never a validation artifact.** Neither
 * seed is the set of buckets the worker actually registers — that comes from
 * `.storage({ bucket, buckets })`, a runtime object codegen does not discover.
 * And because `ruleBuckets` is one of the seeds, the union cannot ever disagree
 * with a rule: a typo'd `defineStorageRule({ bucket })` adds itself to the list
 * of "valid" names. Dropping that seed would not make the union a check either,
 * only a differently-wrong list that rejects legitimate `buckets` keys no
 * `v.storage()` column happens to mention. A rule naming an unaddressable
 * bucket is caught where the registered set is actually known: per request, by
 * `assertRuleBucketsReachable` in `@lunora/server`'s `storage/middleware`.
 */
const buildStorageBucketNames = (schema: SchemaIR, ruleBuckets: ReadonlyArray<string> = []): string[] => {
    const named = new Set<string>();

    for (const table of schema.tables) {
        for (const validator of Object.values(table.shape)) {
            const resolved = unwrapOptional(validator);

            if (resolved.kind === "storage" && typeof resolved.bucket === "string" && resolved.bucket !== "") {
                named.add(resolved.bucket);
            }
        }
    }

    for (const bucket of ruleBuckets) {
        if (bucket !== "" && bucket !== "default") {
            named.add(bucket);
        }
    }

    return ["default", ...[...named].toSorted((a, b) => a.localeCompare(b))];
};

interface EmitServerOptions {
    /** Agents declared via `defineAgent` exports — wires the typed `ctx.agents` producers onto Mutation/Action contexts. */
    agents?: ReadonlyArray<AgentIR>;
    containers?: ReadonlyArray<ContainerIR>;

    /**
     * The single `defineEnv(...)` contract declared in `lunora/env.ts`. When
     * present, `ctx.env` is typed as the validated `InferEnv` shape (recovered
     * via `ReturnType` over the accessor's `typeof`). `undefined` leaves `ctx.env`
     * the base optional binding record — byte-identical to today.
     */
    env?: EnvIR;

    /**
     * A `lunora/` source reads `ctx.access` — wires the verified Cloudflare Access
     * facade (`@lunora/cloudflare-access/context`) onto every ctx. Distinct from
     * `emitApp`'s `hasAccess` (which gates the worker's `.access()` resolveIdentity
     * method); this one gates the per-request `ctx.access` read surface.
     */
    hasAccessFacade?: boolean;
    hasAi?: boolean;
    /** A `lunora/` source uses `@lunora/bindings/analytics` / `ctx.analytics` — wires the write helper onto every ctx. */
    hasAnalytics?: boolean;
    /** A `lunora/` source uses `@lunora/browser` / `ctx.browser` — wires `ctx.browser` onto ActionCtx only. */
    hasBrowser?: boolean;
    /** The project declares `lunora/flags.ts` — wires `ctx.flags` (OpenFeature) onto every ctx. */
    hasFlags?: boolean;
    /** A `lunora/` source uses `@lunora/hyperdrive` / `ctx.sql` — wires `ctx.sql` onto ActionCtx only. */
    hasHyperdrive?: boolean;
    /** A `lunora/` source uses `@lunora/bindings/images` / `ctx.images` — wires `ctx.images` onto ActionCtx only. */
    hasImages?: boolean;
    /** A `lunora/` source uses `@lunora/bindings/kv` / `ctx.kv` — wires `ctx.kv` onto every ctx. */
    hasKv?: boolean;
    /** The project declares `lunora/notify.ts` — wires `ctx.notify` + its `ctx.push` alias (`@lunora/notify`) onto every ctx. */
    hasNotify?: boolean;
    hasPayments?: boolean;
    /** A `lunora/` source uses `@lunora/bindings/pipelines` / `ctx.pipelines` — wires `ctx.pipelines` onto ActionCtx only. */
    hasPipelines?: boolean;
    /** A `lunora/` source uses `@lunora/bindings/r2sql` / `ctx.r2sql` — wires `ctx.r2sql` onto ActionCtx only. */
    hasR2sql?: boolean;
    /** The target platform supports a vector store. `false` withholds `ctx.vectors` even when the schema declares an index. */
    hasVectors?: boolean;
    /** A `lunora/` source uses `@lunora/x402/pay` / `ctx.x402` — wires the agent-wallet pay rail onto ActionCtx only. */
    hasX402?: boolean;

    /**
     * The single `defineIdentity(...)` claim contract declared in
     * `lunora/identity.ts` (Plan 080). When present, `ctx.auth.getIdentity()`,
     * the RLS policy `ctx.auth.identity`, and the shard-authorization hooks
     * narrow to the declared shape (recovered via `InferIdentity` over the
     * contract's `typeof`). `undefined` keeps the identity an untyped bag —
     * byte-identical to today.
     */
    identity?: IdentityIR;
    /** Queues declared via `defineQueue` exports — wires the typed `ctx.queues` producers onto Mutation/Action contexts. */
    queues?: ReadonlyArray<QueueIR>;
    schema?: SchemaIR;
    storageRuleBuckets?: ReadonlyArray<string>;
    /** The project depends on the `lunora` umbrella — import base packages via its subpaths. */
    useUmbrella?: boolean;
    workflows?: ReadonlyArray<WorkflowIR>;
}

/* eslint-disable sonarjs/cognitive-complexity -- emitter that gates each Cloudflare-capability fragment behind its own `has*`/length flag to assemble dense generated TS; the branching is the per-binding emission contract, not refactorable logic */
const emitServer = ({
    agents = [],
    containers = [],
    env,
    hasAccessFacade = false,
    hasAi = false,
    hasAnalytics = false,
    hasBrowser = false,
    hasVectors = true,
    hasFlags = false,
    hasHyperdrive = false,
    hasImages = false,
    hasKv = false,
    hasNotify = false,
    hasPayments = false,
    hasPipelines = false,
    hasR2sql = false,
    hasX402 = false,
    identity,
    queues = [],
    schema,
    storageRuleBuckets = [],
    useUmbrella = false,
    workflows = [],
}: EmitServerOptions = {}): string => {
    const base = baseSpecifiers(useUmbrella);
    /* eslint-disable no-secrets/no-secrets -- the emitted typed-`v` signature (`ColumnValidator<IdOfTable<T>, ...>`) is dense generated TS spread across this template, not a credential */
    // The union of declared storage buckets, narrowing `ctx.storage.bucket(name)`.
    const storageBucketUnion = buildStorageBucketNames(schema ?? { tables: [], vectorIndexes: [] }, storageRuleBuckets)
        .map((name) => JSON.stringify(name))
        .join(" | ");
    // When the project uses Workers AI, the generated ActionCtx carries a typed
    // `ai` helper (from `@lunora/ai`). Inference is an external, non-deterministic
    // call, so — like `ctx.fetch` — it lives on ActionCtx only, not on the
    // query/mutation contexts. Gated so non-AI projects neither see the field nor
    // import `@lunora/ai`.
    const aiTypeImport = hasAi ? `import type { LunoraAi } from "@lunora/ai";\n` : "";
    const aiActionField = hasAi ? `\n    readonly ai: LunoraAi;` : "";
    // Same gating as `ai`: the typed `ctx.payments` facade lives on ActionCtx only
    // (payment ops are external calls), and `@lunora/payment` is imported only when used.
    const paymentsTypeImport = hasPayments ? `import type { LunoraPayment } from "@lunora/payment";\n` : "";
    const paymentsActionField = hasPayments ? `\n    readonly payments: LunoraPayment;` : "";
    // Same gating for the x402 pay rail: it signs and settles USDC over the
    // network, so the typed `ctx.x402` facade rides ActionCtx only, and
    // `@lunora/x402/pay` is imported only when a handler actually uses it.
    const x402TypeImport = hasX402 ? `import type { X402Pay } from "@lunora/x402/pay";\n` : "";
    const x402ActionField = hasX402 ? `\n    readonly x402: X402Pay;` : "";

    // Same gating for containers: container calls are external I/O, so the
    // typed `ctx.containers` record lives on ActionCtx only. One property per
    // `lunora/containers.ts` export, each a `ContainerAccessor` handle.
    const containersTypeImport = containers.length > 0 ? `import type { ContainerAccessor } from "@lunora/container";\n` : "";
    const containersActionField =
        containers.length > 0
            ? `\n    readonly containers: {${containers.map((container) => `\n        readonly ${container.exportName}: ContainerAccessor;`).join("")}\n    };`
            : "";

    // ─── Job A — the typed `Env` / `CloudflareBindings` seam ──────────────────
    //
    // Codegen emits a `CloudflareBindings` interface (aliased as `Env`) so
    // `env.<BINDING>` and service-binding access become typed at the seam every
    // handler reaches `env` through. Codegen can only see the bindings it
    // discovers from source (the `CONTAINER_*` Durable Object namespaces a
    // `defineContainer` declares, the `WORKFLOW_*` namespaces a `defineWorkflow`
    // declares, and the conventional `AI` binding when the project uses Workers
    // AI) — the rest of wrangler's bindings (R2/KV/D1/service/queue/etc.) are
    // user-named and reconciled by the config layer, so the interface keeps an
    // open `[binding: string]: unknown` index signature: a known binding is
    // narrowed, an unknown one is still reachable (cast at the use site). This is
    // the foundation the `ctx.*` augmentations below reuse — `Env` is the single
    // emitted type for the bindings object.
    const envBindingFields = [
        ...(hasAi ? [`    /** Workers AI binding (the conventional \`env.AI\`), narrowing \`ctx.ai\`. */\n    readonly AI?: unknown;`] : []),
        ...containers.map((container) => {
            assertIdentifier(container.bindingName, `container binding "${container.bindingName}"`);

            return `    /** Durable Object namespace for the \`${container.exportName}\` container. */\n    readonly ${container.bindingName}?: unknown;`;
        }),
        ...queues.map((queue) => {
            assertIdentifier(queue.bindingName, `queue binding "${queue.bindingName}"`);

            return `    /** Queue producer binding for the \`${queue.exportName}\` queue. */\n    readonly ${queue.bindingName}?: unknown;`;
        }),
    ].join("\n");
    const envBlock = `

/**
 * This project's Cloudflare bindings, as far as codegen can discover them from
 * \`lunora/\` source — the container/workflow Durable Object namespaces and the
 * conventional Workers AI binding. Bindings the config layer reconciles from
 * user-named wrangler config (R2/KV/D1/\`services\`/queues/…) aren't statically
 * visible here, so the open index signature keeps them reachable (cast at the
 * use site). Service bindings (\`env.<SERVICE>.fetch(...)\` / RPC stubs) live
 * under this signature too — Lunora can't type a third-party worker's RPC
 * surface, so treat them as \`Fetcher\`/\`Service<unknown>\` and cast.
 */
export interface CloudflareBindings {
    readonly [binding: string]: unknown;${envBindingFields ? `\n${envBindingFields}` : ""}
}

/** Alias for {@link CloudflareBindings} — the typed shape of \`env\`. */
export type Env = CloudflareBindings;`;

    // ─── Job B — `ctx.*` augmentations for the new Cloudflare capabilities ─────
    //
    // Each new helper is typed via a type-only dynamic \`import("@lunora/<pkg>")\`
    // in the emitted template (NOT a real import here) — so emit.ts compiles even
    // though those packages may not exist yet, mirroring the codegen emitter's
    // forward-referencing of generated/peer types. The determinism stance follows
    // \`ctx.ai\`: external network/compute I/O lands on ActionCtx ONLY (never the
    // deterministic query/mutation contexts), while write-only / side-effect-free
    // helpers (\`kv\`, \`analytics\`) ride every ctx.
    //
    // The uniform Cloudflare-binding capabilities source their exact ctx-interface
    // fragment (and determinism tier — EVERY ctx for `ctx.kv`/`ctx.analytics`,
    // ActionCtx-only for `ctx.sql`/`ctx.browser`/`ctx.images`/`ctx.pipelines`/
    // `ctx.r2sql`) from the single CAPABILITIES table, so the strings live in one
    // place. `ctx.access` (a synchronous facade type) and `ctx.flags` (an
    // umbrella-aware specifier) are the two exceptions kept bespoke below.
    // `key: CapabilityKey` (not `string`) so a mistyped capability id is a compile
    // error, not a silent `?? ""` drop of the ctx field. The `?? ""` remains only
    // for the legitimate case of a key with no `serverCtxField` in the map.

    /**
     * The ctx-interface fragment for a capability, checked against the determinism
     * tier the table declares for it.
     *
     * `tier` was written seven times and read zero: which interface a fragment
     * landed in was decided purely by which of the three templates below its
     * placeholder appeared in, and nothing compared that against the table. A
     * capability declared `tier: "action"` could be spliced onto `QueryCtx` — and
     * the table exists precisely to stop four parallel lists drifting. `usedAt`
     * is the tier the binding is about to be used at, so a mismatch is a build
     * failure rather than a silently wrong `_generated/server.ts`.
     */
    const serverCapabilityField = (key: CapabilityKey, enabled: boolean, usedAt: CapabilityTier): string => {
        const facet = SERVER_CTX_FIELDS.get(key);

        if (facet !== undefined && facet.tier !== usedAt) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/codegen: capability "${key}" declares tier "${facet.tier}" in SERVER_CTX_FIELDS but is emitted onto the "${usedAt}" context — update whichever is wrong.`,
            );
        }

        return enabled ? (facet?.field ?? "") : "";
    };
    const kvContextField = serverCapabilityField("kv", hasKv, "every");
    const analyticsContextField = serverCapabilityField("analytics", hasAnalytics, "every");
    const hyperdriveActionField = serverCapabilityField("hyperdrive", hasHyperdrive, "action");
    const browserActionField = serverCapabilityField("browser", hasBrowser, "action");
    const imagesActionField = serverCapabilityField("images", hasImages, "action");
    const pipelinesActionField = serverCapabilityField("pipelines", hasPipelines, "action");
    const r2sqlActionField = serverCapabilityField("r2sql", hasR2sql, "action");
    // `ctx.vectors` — narrowed to the schema's declared vector indexes, so a
    // typo'd index name is a compile error rather than a runtime "unknown
    // index" throw from the binding facade. The base surface stays `string`
    // for schema-agnostic consumers.
    // Same source the `VectorIndexName` union is emitted from, so the narrowed
    // ctx field and the union it references appear together or not at all.
    // `hasVectors` is the platform gate's verdict; the index count is the app's
    // declaration. BOTH are required, because a `.vectorize()` column declares
    // the feature without importing anything — so the `featureUsage.vectors`
    // arm never sees it, and a host rating `vectorStore: "unsupported"` used to
    // get the whole surface emitted with no diagnostic. Defaults to `true` so a
    // caller that does not gate (tests, the shard emitter) is unchanged.
    const hasVectorIndexes = hasVectors && (schema?.vectorIndexes.length ?? 0) > 0;
    const vectorsOmit = hasVectorIndexes ? ` | "vectors"` : "";
    const vectorsWriterContextField = hasVectorIndexes ? `\n    readonly vectors: VectorSearch<VectorIndexName>;` : "";
    const vectorsReaderContextField = hasVectorIndexes ? `\n    readonly vectors: VectorSearchReader<VectorIndexName>;` : "";
    // The narrowed surface needs the base generics and the emitted union in scope.
    const vectorsTypeImport = hasVectorIndexes
        ? `import type { VectorSearch, VectorSearchReader } from "${base.server}";\nimport type { VectorIndexName } from "./dataModel.js";\n`
        : "";
    // `ctx.access` — the verified Cloudflare Access identity, a synchronous facade
    // over the already-resolved claims. Rides EVERY ctx (a deterministic read of
    // the per-request identity, like `ctx.auth`; no I/O — verification happened
    // once at the edge in `resolveIdentity`). Gated on a `lunora/` source reading
    // `ctx.access`; the opt-in `accessContext()` middleware is the alternative.
    const accessContextField = hasAccessFacade
        ? `\n    /** Verified Cloudflare Access identity — a synchronous facade over the resolved claims (email / groups / hasGroup / claims). Anonymous when no Access token is present. */\n    readonly access: import("@lunora/cloudflare-access/context").AccessFacade;`
        : "";
    // `ctx.flags` — OpenFeature feature flags. Typed on EVERY ctx: a flag read is
    // an external lookup like `ctx.kv`, sanctioned in deterministic read paths and
    // memoized per request. Gated on the project declaring `lunora/flags.ts`.
    const flagsContextField = hasFlags
        ? `\n    /** Feature-flag evaluation (OpenFeature). Reads are memoized per request; evaluations never throw — a provider error resolves to the supplied default. */\n    readonly flags: import("${base.flags}").LunoraFlags;`
        : "";
    // `ctx.notify` + its `ctx.push` alias — multi-channel notifications
    // (`@lunora/notify`). Typed on EVERY ctx (mirrors `ctx.flags`); the
    // `notify_send_outside_action` lint — not the type — keeps non-deterministic
    // sends out of query/mutation handlers. Gated on the project declaring
    // `lunora/notify.ts`. `@lunora/notify` is an add-on install, never umbrella-remapped.
    const notifyContextField = hasNotify
        ? `\n    /** Multi-channel notifications (@lunora/notify): send / chat / inApp / webhook plus the push device sub-facade. Sends are external I/O — confine them to action handlers. */\n    readonly notify: import("@lunora/notify").LunoraNotify;\n    /** Device push sub-facade — the same object as ctx.notify.push (register / send / broadcast). Sends belong in action handlers. */\n    readonly push: import("@lunora/notify").LunoraPush;`
        : "";

    // Workflows live on BOTH MutationCtx and ActionCtx (a workflow can be kicked
    // off from a mutation or an action — mirrors `ctx.scheduler`). The base
    // contexts already carry an untyped `Workflows`; when the project declares
    // workflows we narrow it to a typed `get(name)` over the exact export names,
    // each handle's params inferred from the `defineWorkflow` definition.
    const hasWorkflows = workflows.length > 0;
    const workflowsTypeImport = hasWorkflows
        ? `import type { WorkflowHandle } from "@lunora/workflow";\nimport type * as lunoraWorkflowDefinitions from "../workflows.js";\n`
        : "";
    const workflowsTypeBlock = hasWorkflows
        ? `

/** Params type carried by a \`defineWorkflow\` definition (its phantom \`__params\`). */
type WorkflowParamsOf<Definition> = Definition extends { __params?: infer Params }
    ? unknown extends Params
        ? Record<string, unknown>
        : NonNullable<Params>
    : Record<string, unknown>;

/** This project's declared workflows, addressable from \`ctx.workflows\` by their \`lunora/workflows.ts\` export name. */
export interface LunoraWorkflows {
${workflows.map((workflow) => `    get(name: ${JSON.stringify(workflow.exportName)}): WorkflowHandle<WorkflowParamsOf<typeof lunoraWorkflowDefinitions.${workflow.exportName}>>;`).join("\n")}
}`
        : "";
    const workflowsOmit = hasWorkflows ? ` | "workflows"` : "";
    const workflowsContextField = hasWorkflows ? `\n    readonly workflows: LunoraWorkflows;` : "";

    // Queues live on BOTH MutationCtx and ActionCtx (enqueue is a side effect, so
    // — like `ctx.scheduler` / `ctx.workflows` — never the deterministic QueryCtx).
    // Each declared queue becomes a typed `QueueProducer<Body>`, the body inferred
    // from the `defineQueue` definition's phantom carrier.
    const hasQueues = queues.length > 0;
    const queuesTypeImport = hasQueues
        ? `import type { QueueProducer } from "@lunora/queue";\nimport type * as lunoraQueueDefinitions from "../queues.js";\n`
        : "";
    const queuesTypeBlock = hasQueues
        ? `

/** Message body type carried by a \`defineQueue\` definition (its phantom \`__lunoraBody\`). */
type QueueBodyOf<Definition> = Definition extends { __lunoraBody?: infer Body } ? (unknown extends Body ? unknown : NonNullable<Body>) : unknown;

/** This project's declared queues, addressable from \`ctx.queues\` by their \`lunora/queues.ts\` export name. */
export interface LunoraQueues {
${queues.map((queue) => `    readonly ${queue.exportName}: QueueProducer<QueueBodyOf<typeof lunoraQueueDefinitions.${queue.exportName}>>;`).join("\n")}
}`
        : "";
    const queuesContextField = hasQueues ? `\n    readonly queues: LunoraQueues;` : "";

    // Agents live on BOTH MutationCtx and ActionCtx (an agent run is kicked off
    // from a mutation or an action — like `ctx.workflows` / `ctx.queues`). Each
    // declared agent becomes a typed `AgentHandle` producer. The base contexts
    // carry no `agents` member, so — like queues — this adds the field without
    // an Omit. The handle is not parameterized by the definition (`run` takes the
    // flat `AgentRunInput`), so no `typeof lunoraAgentDefinitions` import is needed.
    const hasAgents = agents.length > 0;
    const agentsTypeImport = hasAgents ? `import type { AgentHandle } from "@lunora/agent";\n` : "";
    const agentsTypeBlock = hasAgents
        ? `

/** This project's declared agents, addressable from \`ctx.agents\` by their \`lunora/agents.ts\` export name. */
export interface LunoraAgents {
${agents
    .map((agent) => {
        // Defense-in-depth: discovery already guarantees a plain identifier
        // (Node.isIdentifier on the export name), but this string lands in
        // generated source, so refuse anything else here too.
        assertIdentifier(agent.exportName, `agent export "${agent.exportName}"`);

        return `    readonly ${agent.exportName}: AgentHandle;`;
    })
    .join("\n")}
}`
        : "";
    const agentsContextField = hasAgents ? `\n    readonly agents: LunoraAgents;` : "";

    // Typed identity layer (Plan 080). When the project declares the single
    // `defineIdentity(...)` contract in `lunora/identity.ts`, the generated
    // server recovers the claim *type* from the declaration itself (via
    // `InferIdentity<typeof …>` — the same machinery the workflows/queues blocks
    // use to read a declaration by `typeof`, so no parallel type system) and
    // narrows `ctx.auth.getIdentity()`, the RLS policy `ctx.auth.identity`, and
    // the `authorizeShard`/`authorizeFanOut` identity to it. Every fragment is
    // gated on the contract existing, so with no `defineIdentity` the emitted
    // server.ts is byte-identical to before this feature.
    const identityTypeImport = identity
        ? `import type { InferIdentity } from "${base.server}";\nimport type * as lunoraIdentityContract from "../identity.js";\n`
        : "";
    const identityTypeBlock = identity
        ? `

/** This app's declared identity claim contract (\`defineIdentity\` in \`lunora/identity.ts\`) — the typed shape of \`ctx.auth.getIdentity()\`, the RLS policy \`ctx.auth.identity\`, and the \`authorizeShard\`/\`authorizeFanOut\` identity argument. */
export type Identity = InferIdentity<typeof lunoraIdentityContract.${identity.exportName}>;

/** \`ctx.auth\` narrowed so \`getIdentity()\` resolves the declared {@link Identity} contract instead of the untyped claim bag. */
type NarrowedAuth = Omit<QueryCtxBase["auth"], "getIdentity"> & { getIdentity: () => Promise<Identity | null> };`
        : "";
    // Appended to each ctx's `Omit<…Base, …>` key union and body so the narrowed
    // `auth` replaces the base `AuthState`; empty when no contract is declared.
    const authOmit = identity ? ` | "auth"` : "";
    const authContextField = identity ? `\n    readonly auth: NarrowedAuth;` : "";
    // Threads the declared claim type into the relation-aware RLS DSL, so a
    // policy's `ctx.auth.identity` narrows to {@link Identity}. Empty ⇒ the
    // untyped `Record<string, unknown>` default in `createPolicyDsl`.
    const policyIdentityArgument = identity ? ", Identity" : "";

    // `ctx.env` — the validated, typed environment declared by `defineEnv(...)` in
    // `lunora/env.ts`. Like the identity block, only the export binding is lifted;
    // the emitted type recovers the validated shape from the declaration itself
    // (`ReturnType` over the accessor's `typeof`, since `EnvAccessor<S>`'s call
    // signature returns `InferEnv<S>`). Every fragment is gated on the contract
    // existing, so with no `defineEnv` the emitted server.ts is byte-identical.
    const envTypeImport = env ? `import type * as lunoraEnvContract from "../env.js";\n` : "";
    const envTypeBlock = env
        ? `

/** This app's declared env contract (\`defineEnv\` in \`lunora/env.ts\`) — the validated, coercion-aware shape of \`ctx.env\`. */
export type LunoraEnv = ReturnType<typeof lunoraEnvContract.${env.exportName}>;`
        : "";
    // Appended to each ctx's `Omit<…Base, …>` key union so the narrowed, required
    // `env` replaces the base's optional binding record; empty ⇒ the base `env?`
    // is inherited untouched (byte-identical).
    const envOmit = env ? ` | "env"` : "";
    const envContextField = env
        ? `\n    /** Validated, typed environment declared by \`defineEnv\` in \`lunora/env.ts\` — parsed & coercion-aware config values (\`ctx.env.STRIPE_KEY\`); a missing or invalid value throws at read time. */\n    readonly env: LunoraEnv;`
        : "";

    const server = `${GENERATED_HEADER}import { createPolicyDsl, defineMutator as defineMutatorBase, initLunora, v as vBase } from "${base.server}";
import type {
    ActionBuilder,
    ActionCtx as ActionCtxBase,
    ColumnValidator,
    DatabaseReader,
    DatabaseWriter,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    MutationBuilder,
    MutationCtx as MutationCtxBase,
    MutationStorage,
    MutatorDefinition,
    QueryBuilder,
    QueryCtx as QueryCtxBase,
    ReadOnlyStorage,
    RegisteredMutator,
    Storage as StorageBase,
    TableReader,
    Validator,
} from "${base.server}";

import type {
    DatabaseReaderFacade as DatabaseReaderFacadeOf,
    DatabaseWriterFacade as DatabaseWriterFacadeOf,
    LoadWith as LoadWithOf,
    TableReaderFacade as TableReaderFacadeOf,
    TableWriterFacade as TableWriterFacadeOf,
    WithArg as WithArgOf,
} from "${base.serverDataModel}";

export type {
    AggregateOp,
    GroupByEntry,
    OrderBy,
    QueryArgs,
    QueryPage,
    RankPage,
    RankResult,
    RestrictableQueryOptions,
    RestrictableQueryOptionsOf,
    SearchFilterBuilder,
    SearchReader,
    TableAggregateOptions,
    TableAggregateOptionsOf,
    TableGroupByOptions,
    TableGroupByOptionsOf,
    TableRankOptions,
    TableRankPageOptions,
    Where,
    WhereOf,
    WhereOperators,
} from "${base.serverDataModel}";

import type { DataModel, Doc, GeoIndexNamesByTable, Id as IdOfTable, IndexNamesByTable, Insert, InsertModel, RankIndexNamesByTable, Relations, SearchIndexNamesByTable, TableName } from "./dataModel.js";
${vectorsTypeImport}${aiTypeImport}${paymentsTypeImport}${x402TypeImport}${containersTypeImport}${workflowsTypeImport}${queuesTypeImport}${agentsTypeImport}${identityTypeImport}${envTypeImport}
export type { AppTableName, DataModel, Doc, Id, TableName } from "./dataModel.js";

/**
 * The query-DSL bindings: \`@lunora/server/data-model\`'s generics parameterized
 * over this project's \`DataModel\` / \`InsertModel\` / \`Relations\` / index maps.
 *
 * They live here rather than in \`dataModel.ts\` because they are the half that
 * needs the SERVER package. Keeping \`dataModel.ts\` free of it lets a sibling
 * package — a web app, another Worker — compile \`api.ts\` for its \`Doc\`/\`Id\`
 * types without installing a server dependency to do it.
 */

/** The \`with\` argument for table \`T\` — see \`@lunora/server/data-model\`. */
export type WithArg<T extends keyof DataModel> = WithArgOf<DataModel, Relations, T>;

/** \`Doc<T>\` narrowed to exactly the relations requested in the with-arg \`W\`. */
export type LoadWith<T extends keyof DataModel, W> = LoadWithOf<DataModel, Relations, T, W>;

/** Read-only typed table accessor exposed on \`QueryCtx.db.<table>\`. */
export type TableReaderFacade<T extends keyof DataModel> = TableReaderFacadeOf<DataModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, T, GeoIndexNamesByTable>;

/** Read-write typed table accessor exposed on \`MutationCtx.db.<table>\` / \`ActionCtx.db.<table>\`. */
export type TableWriterFacade<T extends keyof DataModel> = TableWriterFacadeOf<DataModel, InsertModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, T, GeoIndexNamesByTable>;

/** Per-table read facade — \`ctx.db.<table>\` on a \`QueryCtx\`. */
export type DatabaseReaderFacade = DatabaseReaderFacadeOf<DataModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, GeoIndexNamesByTable>;

/** Per-table read-write facade — \`ctx.db.<table>\` on a \`MutationCtx\` / \`ActionCtx\`. */
export type DatabaseWriterFacade = DatabaseWriterFacadeOf<DataModel, InsertModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, GeoIndexNamesByTable>;

/** Insert builder returned by \`ctx.orm.insert(table)\`. */
export interface OrmInsertBuilder<T extends keyof DataModel> {
    values: (values: Insert<T>) => Promise<IdOfTable<T>>;
}

/** Replace builder returned by \`ctx.orm.replace(table, id)\` — swaps the whole document. */
export interface OrmReplaceBuilder<T extends keyof DataModel> {
    with: (values: Insert<T>) => Promise<void>;
}

/** Update builder returned by \`ctx.orm.update(table, id)\` — patches the named fields. */
export interface OrmUpdateBuilder<T extends keyof DataModel> {
    set: (values: Partial<Insert<T>>) => Promise<void>;
}

/** Read-only ORM surface — \`ctx.orm\` on a \`QueryCtx\`. Mirrors \`ctx.db\` reads under a kitcn-style \`query\` namespace. */
export interface OrmReader {
    query: DatabaseReaderFacade;
}

/** Read-write ORM surface — \`ctx.orm\` on a \`MutationCtx\` / \`ActionCtx\`. Writes are addressed by id, like \`ctx.db\`. */
export interface OrmWriter extends OrmReader {
    delete: <T extends keyof DataModel>(table: T, id: IdOfTable<T>) => Promise<void>;
    insert: <T extends keyof DataModel>(table: T) => OrmInsertBuilder<T>;
    replace: <T extends keyof DataModel>(table: T, id: IdOfTable<T>) => OrmReplaceBuilder<T>;
    update: <T extends keyof DataModel>(table: T, id: IdOfTable<T>) => OrmUpdateBuilder<T>;
}

/** Storage buckets this schema declares (\`v.storage("name")\`), narrowing \`ctx.storage.bucket(name)\`. */
export type StorageBucketName = ${storageBucketUnion};${envBlock}${workflowsTypeBlock}${queuesTypeBlock}${agentsTypeBlock}${identityTypeBlock}${envTypeBlock}

/**
 * Project-typed contexts. The base contexts from \`@lunora/server\` are
 * untyped against the schema; here \`db\` is widened to the generated per-table
 * facade (\`ctx.db.<table>.findMany(...)\`) while keeping the legacy structural
 * \`db.get\`/\`db.query\` surface for back-compat, and \`storage\` is narrowed so
 * \`ctx.storage.bucket(name)\` autocompletes the declared buckets.
 */
/**
 * The Convex-style fluent reader \`ctx.db.query(table)\`, bound to this schema:
 * a table-name literal narrows the row type, so \`.collect()\` / \`.first()\` /
 * \`.take()\` (and the \`.withIndex()\` / \`.filter()\` / \`.order()\` chain) resolve
 * as \`Doc<table>\` with no \`as unknown as Doc<...>\` casts. The per-table accessor
 * \`ctx.db.<table>\` stays available alongside it via the facade.
 *
 * Intersected with the wide \`(string) => TableReader\` signature so the bound
 * \`ctx.db\` is still structurally assignable to schema-agnostic consumers that
 * call \`db.query(someString)\` (e.g. \`@lunora/ratelimit\`'s \`createDbStore\`).
 *
 * The three index-name unions are what make \`.withIndex("by_TYPO")\` a compile
 * error: each resolves to the table's declared names, or \`never\` when it
 * declares none of that kind. Without them a renamed or dropped index left
 * every call site typechecking, and the query either threw at runtime or
 * degraded silently to a full table scan.
 */
type TypedTableQuery = (<T extends TableName>(
    table: T,
) => TableReader<Doc<T>, IndexNamesByTable[T], SearchIndexNamesByTable[T], GeoIndexNamesByTable[T]>) &
    ((table: string) => TableReader);

/**
 * The point read \`ctx.db.get(id)\`, bound to this schema: an \`Id<"table">\`
 * carries its table name, so the resolved document is typed \`Doc<table>\` (or
 * \`null\` when absent) with no \`as Doc<...>\` cast. Mirrors {@link TypedTableQuery}.
 */
type TypedTableGet = <T extends TableName>(id: IdOfTable<T>) => Promise<Doc<T> | null>;

/**
 * Resolves the \`asId\` table argument: a literal in {@link TableName} passes through, a
 * genuinely-wide \`string\` (a computed name) passes through, and any OTHER literal
 * collapses to \`never\` so it fails to typecheck.
 *
 * The \`string extends T\` arm is what distinguishes "the caller passed a computed
 * string" from "the caller passed a misspelled literal" — only the wide \`string\` type
 * is a supertype of \`string\`.
 */
type AsIdTable<T extends string> = T extends TableName ? T : string extends T ? T : never;

/**
 * The id parse boundary \`ctx.db.asId(table, id)\`, bound to this schema: a misspelled
 * table literal is a compile error rather than a call that hands back a confidently-
 * branded id for a table that does not exist. Mirrors {@link TypedTableQuery} /
 * {@link TypedTableGet}.
 *
 * Deliberately NOT an intersection with a wide \`(string, string) => string\` overload:
 * overload resolution would fall through to it for a bad literal, silently restoring
 * the very typo hole this narrowing exists to close. {@link AsIdTable} instead keeps a
 * computed table name working — and keeps \`ctx.db\` structurally assignable to
 * schema-agnostic consumers — without accepting an invalid literal.
 */
type TypedAsId = <T extends string>(tableName: AsIdTable<T>, id: string) => IdOfTable<T & TableName>;

export interface QueryCtx extends Omit<QueryCtxBase, "db" | "storage"${vectorsOmit}${authOmit}${envOmit}> {
    readonly db: Omit<DatabaseReader, "asId" | "query" | "get"> & DatabaseReaderFacade & { asId: TypedAsId; query: TypedTableQuery; get: TypedTableGet };
    readonly orm: OrmReader;
    readonly storage: ReadOnlyStorage<StorageBucketName>;${vectorsReaderContextField}${accessContextField}${kvContextField}${flagsContextField}${notifyContextField}${analyticsContextField}${envContextField}${authContextField}
}

export interface MutationCtx extends Omit<MutationCtxBase, "db" | "storage"${vectorsOmit}${workflowsOmit}${authOmit}${envOmit}> {
    readonly db: Omit<DatabaseWriter, "asId" | "query" | "get"> & DatabaseWriterFacade & { asId: TypedAsId; query: TypedTableQuery; get: TypedTableGet };
    readonly orm: OrmWriter;
    readonly storage: MutationStorage<StorageBucketName>;${vectorsWriterContextField}${accessContextField}${kvContextField}${flagsContextField}${notifyContextField}${analyticsContextField}${envContextField}${workflowsContextField}${queuesContextField}${agentsContextField}${authContextField}
}

export interface ActionCtx extends Omit<ActionCtxBase, "db" | "storage"${vectorsOmit}${workflowsOmit}${authOmit}${envOmit}> {
    readonly db: Omit<DatabaseWriter, "asId" | "query" | "get"> & DatabaseWriterFacade & { asId: TypedAsId; query: TypedTableQuery; get: TypedTableGet };
    readonly orm: OrmWriter;
    readonly storage: StorageBase<StorageBucketName>;${vectorsWriterContextField}${accessContextField}${aiActionField}${paymentsActionField}${x402ActionField}${containersActionField}${kvContextField}${flagsContextField}${notifyContextField}${hyperdriveActionField}${browserActionField}${imagesActionField}${analyticsContextField}${pipelinesActionField}${r2sqlActionField}${envContextField}${workflowsContextField}${queuesContextField}${agentsContextField}${authContextField}
}

/**
 * Procedure builders bound to this project's typed contexts. Chain
 * \`.input({...})\` to declare args, \`.use(middleware)\` for rate limiting / RLS /
 * masking (each middleware may refine \`ctx\`), then the terminal
 * \`.query()\` / \`.mutation()\` / \`.action()\` with a \`({ ctx, args }) => ...\`
 * handler. \`.output(validator)\` and (queries) \`.stream()\` are also available.
 */
const lunoraBuilders = initLunora.dataModel<DataModel>().create();

/** \`query\` builder bound to this project's typed {@link QueryCtx}. */
export const query = lunoraBuilders.query as unknown as QueryBuilder<QueryCtx, EmptyArgs>;

/** \`mutation\` builder bound to this project's typed {@link MutationCtx}. */
export const mutation = lunoraBuilders.mutation as unknown as MutationBuilder<MutationCtx, EmptyArgs>;

/** \`action\` builder bound to this project's typed {@link ActionCtx}. */
export const action = lunoraBuilders.action as unknown as ActionBuilder<ActionCtx, EmptyArgs>;

/** \`internalQuery\` builder bound to this project's typed {@link QueryCtx} — never exposed on \`api\`. */
export const internalQuery = lunoraBuilders.internalQuery as unknown as InternalQueryBuilder<QueryCtx, EmptyArgs>;

/** \`internalMutation\` builder bound to this project's typed {@link MutationCtx} — never exposed on \`api\`. */
export const internalMutation = lunoraBuilders.internalMutation as unknown as InternalMutationBuilder<MutationCtx, EmptyArgs>;

/** \`internalAction\` builder bound to this project's typed {@link ActionCtx} — never exposed on \`api\`. */
export const internalAction = lunoraBuilders.internalAction as unknown as InternalActionBuilder<ActionCtx, EmptyArgs>;

/**
 * \`defineMutator\` bound to this project's typed {@link MutationCtx} — declare
 * custom mutators (\`lunora/mutators.ts\`) with it instead of importing from
 * \`${base.server}\`, and the authoritative \`server\` impl's \`ctx\` carries the
 * schema-typed \`ctx.db\` (\`ctx.db.query("nodes")\` resolves \`Doc<"nodes">\`,
 * \`ctx.db.patch(id, …)\` takes an \`Id<"nodes">\`) with no hand-written ctx type and
 * no \`as unknown as\` cast. Runtime-identical to the package export; only the
 * context type narrows, so discovery finds a mutator authored either way.
 * @example
 * export const setText = defineMutator({
 *     args: { id: v.id("nodes"), text: v.string() },
 *     server: async (ctx, args) => { await ctx.db.patch(args.id, { text: args.text }); },
 * });
 */
export const defineMutator = defineMutatorBase as unknown as <Args extends Record<string, Validator> = Record<string, Validator>, ClientTx = unknown, R = unknown>(
    definition: MutatorDefinition<Args, MutationCtx, ClientTx, R>,
) => RegisteredMutator<Args, MutationCtx, ClientTx, R>;

/**
 * \`definePolicy\` bound to THIS schema's {@link DataModel} + {@link Relations}.
 * Import it from here (\`./_generated/server\`) instead of \`@lunora/server\` to get
 * a relation-aware RLS authoring surface: \`table\` autocompletes to a real table
 * name and the \`when\` predicate type-checks against the table's columns **and**
 * its declared relations — \`{ author: { is: {...} } }\`, \`{ posts: { some: {...} } }\`,
 * etc. (the \`@lunora/do\` pre-resolver resolves relation predicates on reads).
 * Runtime-identical to \`@lunora/server\`'s \`definePolicy\`; only the types narrow,
 * so the \`rls()\` chain discovers a policy authored either way the same.
 */
export const definePolicy = createPolicyDsl<DataModel, Relations${policyIdentityArgument}>();

/**
 * The validator builder \`v\`, with \`v.id(...)\` constrained to THIS schema's
 * table names — so the argument autocompletes and returns a precise
 * \`Id<"table">\`. Identical to \`@lunora/server\`'s \`v\` at runtime; the only
 * difference is the tightened \`id\` type.
 *
 * Import \`v\` from here (\`./_generated/server\`) in your queries/mutations/actions
 * to get table-name autocomplete. \`lunora/schema.ts\` can't use it — it is the
 * file that defines the table names, so they aren't known yet there; pass the
 * names as string literals and the generated \`Id<"table">\` types still catch a
 * typo wherever the id is used.
 */
export const v = vBase as unknown as Omit<typeof vBase, "id"> & {
    id: <T extends TableName>(table: T) => ColumnValidator<IdOfTable<T>, IdOfTable<T>>;
};
`;
    /* eslint-enable no-secrets/no-secrets */

    return server;
};

export default emitServer;
