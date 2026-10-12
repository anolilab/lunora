/**
 * Deployment surfaces: crons, containers, workflows, agents, queues, topics, modules, services, flags, and the wrangler and project facts.
 */
import type { CallSiteScope } from "./call-sites";
import type { FunctionIR, HandlerSiteIR, HttpRouteIR } from "./functions";
import type { MigrationIR, SchemaIR } from "./schema";

/**
 * A single cron job lifted from a `cronJobs()` builder in `lunora/crons.ts`.
 * Mirrors `@lunora/scheduler`'s `CronJob`: {@link CronJobIR.cron} is the compiled
 * standard cron expression, {@link CronJobIR.functionPath} is the target
 * `__lunoraRef` (`namespace:fn`), and {@link CronJobIR.args} is the static
 * argument object passed at registration.
 */
export interface CronJobIR {
    /** Static args object (source-text JSON), defaults to `{}`. */
    args: Record<string, unknown>;
    /** Compiled standard cron expression, e.g. `"0 9 * * *"`. */
    cron: string;
    /** Target function ref `namespace:fn`. Present for a function target; absent when {@link CronJobIR.workflow} is set. */
    functionPath?: string;
    /** Unique, human-readable job name. */
    name: string;

    /**
     * Set when the job targets a durable workflow (a `lunora/workflows.ts`
     * export) instead of a function: the workflow's class name (its
     * `ctx.exports` key) plus its export name. On each fire the worker starts a new workflow
     * INSTANCE (the {@link CronJobIR.args} become its `params`) rather than
     * dispatching a one-shot function.
     */
    workflow?: { className: string; exportName: string };
}

/** A normalized container image source, as written into `wrangler.jsonc`. */
export type ContainerImageIR =
    { buildContext: string; dockerfilePath: string; kind: "dockerfile" } | { buildDir: string; kind: "build" } | { kind: "registry"; reference: string };

/** A `durable_object` container's named image — a Dockerfile or a registry digest, never a Railpack build. */
export type ContainerNamedImageIR = Exclude<ContainerImageIR, { kind: "build" }>;

/** The fields every container carries, whichever scheduling policy it uses. */
export interface ContainerIRBase {
    /** Durable Object binding name, e.g. `CONTAINER_TRANSCODER`. */
    bindingName: string;
    /** Static Dockerfile build args (wrangler `image_vars` / named-image `build_vars`), when declared as literals. */
    buildArgs?: Record<string, string>;
    /** Generated DO class name, e.g. `TranscoderContainer`. */
    className: string;

    /**
     * Whether the container may open outbound internet connections, when the
     * value was a static literal. `undefined` means the field was omitted (the
     * platform default is `true`) or wasn't a literal. Lifted for the advisor.
     */
    enableInternet?: boolean;
    /** The `lunora/containers.ts` export name, e.g. `transcoder`. */
    exportName: string;
    /** Static `instanceType`, when declared (the default size, under `durable_object`). */
    instanceType?: string | { diskMb?: number; memoryMib?: number; vcpu?: number };
    /** Static wrangler `containers[].name` override, when declared. */
    name?: string;

    /**
     * `true` when the definition opts in to the Sandbox SDK helpers
     * (`defineContainer({ sandbox: true })`). Must be a literal: it decides
     * whether the generated `containers.ts` exports the sandbox gateways, and
     * it raises the `containerSandboxTools` platform signal.
     */
    sandbox?: boolean;

    /**
     * The static `sleepAfter` value, when it was a literal. `undefined` means
     * omitted (platform default `"10m"`) or non-literal. Lifted for the advisor.
     */
    sleepAfter?: number | string;
}

/** A container under the default scheduling policy: one application image, a cap, and a rollout. */
export interface DefaultScheduledContainerIR extends ContainerIRBase {
    /**
     * Normalized image source: a local Dockerfile (`dockerfile`), a pre-built
     * registry reference (`registry`), or a Railpack source directory (`build`)
     * that the deploy step builds and pushes before wrangler runs.
     */
    image: ContainerImageIR;
    /** Static `maxInstances`, when declared. */
    maxInstances?: number;
    /** Static rolling-deploy tuning, when declared as literals. */
    rollout?: { gracePeriodSeconds?: number; stepPercentage?: number };
    /** Absent under the default policy — the union's discriminant. */
    schedulingPolicy?: never;
}

/**
 * A container under the `durable_object` scheduling policy (wrangler
 * `scheduling_policy`): each instance picks its image and size per start. Also
 * the `containerRuntimeScheduling` platform signal.
 */
export interface DurableObjectScheduledContainerIR extends ContainerIRBase {
    /** The named images an instance can start from (wrangler `containers[].images`). */
    images?: Record<string, ContainerNamedImageIR>;
    schedulingPolicy: "durable_object";
}

/**
 * A container lifted from a `defineContainer()` export in
 * `lunora/containers.ts`, discriminated on its scheduling policy. Carries
 * everything the emitters and the config layer need to wire wrangler
 * (`containers[]` + the Durable Object binding + migration class) and the
 * generated `_generated/containers.ts` DO class. Names are derived via
 * `@lunora/container`'s shared helpers so codegen and the config layer can
 * never disagree.
 */
export type ContainerIR = DefaultScheduledContainerIR | DurableObjectScheduledContainerIR;

/**
 * A workflow lifted from a `defineWorkflow()` export in `lunora/workflows.ts`.
 * Carries what the emitters and the config layer need to wire the wrangler
 * `workflows[]` entry and the generated `_generated/workflows.ts`
 * `WorkflowEntrypoint` class. Unlike containers, workflows are NOT Durable
 * Objects — wrangler gets only a `workflows[]` entry, never a `durable_objects`
 * binding or a migration class. Names are derived via `@lunora/workflow`'s
 * shared helpers so codegen and the config layer can never disagree.
 */
export interface WorkflowIR {
    /** Generated `WorkflowEntrypoint` class name, e.g. `OrderPipelineWorkflow` — also its `exports` key and `ctx.exports` property. */
    className: string;
    /** Static `defaultRetention` literal → `exports.<Class>.default_retention`. */
    defaultRetention?: { errorRetention?: string; successRetention?: string };
    /** The `lunora/workflows.ts` export name, e.g. `orderPipeline`. */
    exportName: string;

    /**
     * The file declaring the `handler:` when it is a function passed by reference
     * and declared in another file — the file {@link WorkflowIR.steps}' lines are
     * in. Lunora-relative inside `lunora/`, project-relative outside it.
     */
    handlerFile?: string;
    /** See {@link HandlerSiteIR}. */
    handlerSite?: HandlerSiteIR;
    /** Static `limits` literal → `exports.<Class>.limits`. */
    limits?: { steps?: number };

    /**
     * The stable wrangler `exports.<Class>.name`. Defaults to the kebab-cased export
     * name (`orderPipeline` → `order-pipeline`); a static `name:` literal in the
     * definition overrides it.
     */
    name: string;

    /**
     * Static `schedules` cron literals → `exports.<Class>.schedules`. Each one
     * starts an instance on Cloudflare; gated by the `workflowSchedules`
     * capability, since a host that ignores them would never run the workflow.
     */
    schedules?: ReadonlyArray<string>;

    /**
     * Durable step labels lifted from the handler body — the first string-literal
     * argument of every `ctx.step.do` / `.sleep` / `.sleepUntil` / `.waitForEvent`
     * call. Feeds the duplicate-step-name lint, which flags a name used twice
     * (Cloudflare memoizes by name, so the second call silently returns the
     * first's cached result). Calls with a non-literal name are omitted (not
     * statically comparable). A handler passed by reference is followed to its
     * declaration; the lines are then in {@link WorkflowIR.handlerFile}.
     */
    steps: ReadonlyArray<WorkflowStepIR>;
}

/**
 * An agent lifted from a `defineAgent()` export in `lunora/agents.ts`. A
 * `defineAgent` compiles its durable tool-loop onto a Cloudflare Workflow, so —
 * like {@link WorkflowIR} — an agent is NOT a Durable Object: wrangler gets only
 * a `workflows[]` entry, never a `durable_objects` binding or a migration class.
 * Carries what the emitters and the config layer need to wire the generated
 * agent `WorkflowEntrypoint` class (e.g. `SupportAgentWorkflow`), the typed
 * per-agent `ctx.agents` producer, and the reconciled wrangler `workflows[]`
 * entry. Names are derived via `@lunora/agent`'s shared helpers so codegen and
 * the config layer can never disagree.
 */
export interface AgentIR {
    /** Generated `WorkflowEntrypoint` class name, e.g. `SupportAgentWorkflow` — also its `exports` key and `ctx.exports` property. */
    className: string;
    /** The `lunora/agents.ts` export name, e.g. `support`. */
    exportName: string;

    /**
     * The stable wrangler `exports.<Class>.name`. Defaults to the kebab-cased export
     * name (`support` → `agent-support`); a static `name:` literal in the
     * definition overrides it.
     */
    name: string;

    /**
     * Whether the definition declares an `onEmail` mapper on
     * `defineAgent({ onEmail: … })`. When `true` the emitter wires this agent
     * onto the worker's top-level `email()` handler (via `@lunora/agent/inbound`)
     * so inbound mail starts a durable run. Detected by AST PRESENCE — the
     * closure is never evaluated — and written to IR only when present, so
     * email-free agents (and agent-free projects) stay byte-identical.
     */
    onEmail?: boolean;

    /**
     * Whether the definition opted into public run-starts via
     * `defineAgent({ publicRun: true })` — emitted into the `ctx.agents` wiring
     * spec so the public `agents:agentRun` mutation can gate on it fail-closed.
     * Absent (falsy) means server-side starts only; the field is written to IR
     * only when the literal is `true`, so agent-free and non-opted-in output is
     * byte-identical.
     */
    publicRun?: boolean;

    /**
     * Whether the definition opted into a real-time voice session via a `voice`
     * block on `defineAgent({ voice: … })`. Unlike the durable loop (a Workflow),
     * the voice path IS a Durable Object — so when this is `true` the emitter
     * generates the `voiceClassName` `VoiceSessionDO` subclass and the
     * `api.agents.{name}Voice` client reference, and the config layer reconciles
     * a `durable_objects` binding (`voiceBindingName`) + `new_sqlite_classes`
     * migration. Written to IR only when the literal is present, so voice-free
     * agents (and agent-free projects) stay byte-identical.
     */
    voice?: boolean;

    /** The voice DO's Cloudflare `DurableObjectNamespace` binding name, e.g. `VOICE_SUPPORT`. Present only when `voice`. */
    voiceBindingName?: string;

    /** Generated `VoiceSessionDO` subclass name, e.g. `SupportVoiceDO`. Present only when `voice`. */
    voiceClassName?: string;
}

/** One durable step call lifted from a workflow handler body (the use side of {@link WorkflowIR.steps}). */
export interface WorkflowStepIR {
    /** 1-based line of the durable step call. */
    line: number;
    /** The native step method invoked: `do` / `sleep` / `sleepUntil` / `waitForEvent`. */
    method: string;
    /** The step's static label (the first string-literal argument). */
    name: string;
}

/**
 * A queue lifted from a `defineQueue()` export in `lunora/queues.ts`. Carries
 * what the emitters and the config layer need to wire the typed `ctx.queues`
 * producer, the generated worker `queue()` dispatch, and the wrangler
 * `queues.producers[]` / `queues.consumers[]` entries. Like workflows, a queue
 * is NOT a Durable Object — wrangler gets only `queues.*` entries. Names are
 * derived via `@lunora/queue`'s shared helpers so codegen and the config layer
 * can never disagree.
 */
export interface QueueIR {
    /** The Cloudflare `Queue` producer binding name, e.g. `QUEUE_EMAIL`. */
    bindingName: string;
    /** The `lunora/queues.ts` export name, e.g. `emailQueue`. */
    exportName: string;
    /** The declaring file, lunora-relative without `.ts`: `queues`, or `billing/queues` for a module's own. */
    filePath: string;

    /** See {@link HandlerSiteIR}. */
    handlerSite?: HandlerSiteIR;
    /** How the queue is consumed: `"push"` (a worker `queue()` handler) or `"pull"` (external HTTP). */
    mode: "pull" | "push";

    /**
     * The stable wrangler queue name (`queues.producers[].queue`). Defaults to
     * the kebab-cased export name (`emailQueue` → `email-queue`); a static
     * `name:` literal in the definition overrides it.
     */
    name: string;

    /**
     * Set for a `defineSubscription(topic, …)` export: the `defineTopic` export it
     * consumes. A subscription is an ordinary push queue everywhere except
     * `ctx.*` — it is published to through `ctx.topics.<topic>`, never `ctx.queues`.
     */
    topic?: string;
    /** Push-consumer batch/retry tuning, mirrored onto the wrangler `queues.consumers[]` entry. */
    tuning: {
        deadLetterQueue?: string;
        maxBatchSize?: number;
        maxBatchTimeout?: number;
        maxConcurrency?: number;
        maxRetries?: number;
        retryDelay?: number;
    };
}

/**
 * A `defineTopic()` export in `lunora/queues.ts`. A topic deploys nothing of its
 * own: each subscription is a {@link QueueIR} whose `topic` names this export, and
 * that is the only record of the link (see {@link subscriptionsOf}).
 */
export interface TopicIR {
    /** The `lunora/queues.ts` export name, e.g. `signups`. */
    exportName: string;
    /** The declaring file, as {@link QueueIR.filePath}. */
    filePath: string;
}

/** The queues published to through `ctx.queues` — every queue except a topic subscription. */
export const plainQueues = (queues: ReadonlyArray<QueueIR>): QueueIR[] => queues.filter((queue) => queue.topic === undefined);

/** The subscription queues consuming one topic. */
export const subscriptionsOf = (queues: ReadonlyArray<QueueIR>, topic: string): QueueIR[] => queues.filter((queue) => queue.topic === topic);

/**
 * A module: a folder under `lunora/` whose `module.ts` default-exports
 * `defineModule(...)`. Metadata for the Studio catalog, the architecture
 * manifest and the `cross_module_table_write` lint — it changes no `api.*` path.
 */
export interface ModuleIR {
    /** One-line description from `defineModule({ description })`. */
    description?: string;

    /**
     * `true` for an installed component (a `defineSchemaExtension` key merged with
     * `.extend(...)`) treated as a module: it owns its prefixed tables and the
     * `lunora/<key>/` folder its copy-in code lives in. Absent for a declared module.
     */
    installed?: true;

    /** The folder path relative to `lunora/`, e.g. `billing` — also the module's name. */
    name: string;

    /**
     * `false` for an installed component shipped as a package: its code is in
     * `node_modules`, so it owns its tables but no `lunora/<key>/` folder (an app
     * folder of that name stays the app's). Absent means the module owns its folder.
     */
    ownsFolder?: false;
    /** Tables the module declares it owns (`defineModule({ tables })`); empty when it declares none. */
    tables: ReadonlyArray<string>;
}

/**
 * A sibling Worker the app calls through a Cloudflare service binding, declared in
 * `lunora.config.*` `services` (plan 457). Becomes a wrangler `services[]` entry,
 * a typed `ctx.services.<name>` on actions, and a `service` node in the
 * architecture manifest.
 */
export interface ServiceBindingIR {
    /** The `services[].binding` Lunora writes, e.g. `SERVICE_DOCUMENT_PARSER`. */
    binding: string;
    /** The exported `WorkerEntrypoint` class the binding targets; absent for the Worker's default export. */
    entrypoint?: string;

    /**
     * The Worker name per `env.<name>` block the service's own wrangler config
     * sets a `name` in. An environment missing here deploys as wrangler's
     * default `<worker>-<env>`.
     */
    envWorkers: Readonly<Record<string, string>>;
    /** Absolute path of the service's entry module (its wrangler `main`) — what the RPC type is read from. */
    main: string;
    /** The `ctx.services.<name>` key, e.g. `documentParser`. */
    name: string;

    /**
     * The scopes in which the service still serves on `*.workers.dev` with no
     * route of its own: `""` for the top level, else the environment name.
     */
    publicScopes: ReadonlyArray<string>;

    /**
     * The `WorkerEntrypoint` class the service is typed — and wired — as an RPC
     * stub of. Equal to {@link ServiceBindingIR.entrypoint} for an RPC service;
     * absent for a fetch service, including a named entrypoint declared
     * `rpc: false`, which is called with plain `fetch` and so needs no import of
     * the service's sources.
     */
    rpcEntrypoint?: string;
    /** The Worker's own `name` from its wrangler config — the `services[].service` target. */
    worker: string;
    /** Absolute path of the service's wrangler config. */
    wranglerPath: string;
}

/**
 * The feature-flag provider declared by the default export of `lunora/flags.ts`
 * (`defineFlags({ provider, … })`). Discovery is **metadata-only** — codegen
 * imports the real module at runtime for the provider value; this IR exists so
 * the config layer can reconcile/validate the wrangler `flagship` binding when
 * the app uses Flagship in binding mode. A `custom` provider (any other
 * OpenFeature factory) carries no binding to reconcile.
 */
export interface FlagsIR {
    /**
     * The wrangler `flagship[].binding` name — set **only** for a flagship
     * `provider` in binding mode (`flagshipProvider({ binding: "FLAGS" })`). The
     * config layer hints/validates a matching `flagship` binding from this.
     */
    bindingName?: string;

    /**
     * Flagship operating mode — `"binding"` (wrangler binding, needs a
     * `flagship` entry) or `"http"` (no binding); `undefined` for a `custom`
     * provider or when the mode can't be read statically.
     */
    mode?: "binding" | "http";
    /** `"flagship"` when the provider is `flagshipProvider(...)`, else `"custom"` (any other OpenFeature provider factory). */
    provider: "custom" | "flagship";
}

/**
 * One `ctx.containers.<exportName>.get(name, …)` call whose instance key is derived
 * from the handler's `args` with no server-side scoping — the
 * `container_instance_key_from_user_input` lint input. Each container definition's
 * `.get(name)` accessor routes to one instance per `name`, so a key taken straight from
 * request input lets any caller reach another tenant's container (a cross-tenant IDOR). A
 * fixed literal key, or one derived from a server-trusted identity (`${ctx.auth.userId}` —
 * references `ctx`, so treated as scoped), is not recorded; only an arg-derived, unscoped
 * key reaches here. `.any()`/`.pool()` take no key and are not sinks. Structurally
 * identical to `AdvisorContainerKeyAccess`.
 */
export interface ContainerKeyAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.containers.*.get` call, or `0` when unknown. */
    line: number;
    /** The container accessor method invoked — always `get`. */
    method: string;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One runtime container-override call: a `<handle>.start({ enableInternet: true, … })`
 * launch override, or a `<handle>.egress.<method>(...)` runtime firewall mutation
 * (`allow` / `deny` / `setAllowed`) — the `container_start_enable_internet_override`
 * and `container_runtime_egress_relaxation` lint input. Both shapes re-open network
 * access the static `defineContainer` declaration (and its `container_public_internet`
 * lint) assumes is locked down. Matched structurally by call shape, independent of the
 * receiver's resolved type. Structurally identical to `AdvisorContainerOverride`.
 */
export interface ContainerOverrideIR {
    /** e.g. the egress method name, or `"enableInternet: true"`. */
    detail: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which override shape matched. */
    kind: "egress_relaxation" | "enable_internet";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `buildImageDeliveryUrl({ key, … })` call (`@lunora/bindings/images`) whose
 * `key` — the CDN transform's source image, an absolute URL or an
 * origin-relative key — is derived from the handler's `args` with no
 * server-side scoping — the `images_url_source_from_user_input` lint input.
 * `ctx.images.transform`/`info` take image *bytes*, never a URL, so they are not
 * sinks; only the `key` of `buildImageDeliveryUrl` accepts a URL-or-key source
 * and is inspected. An arg-derived `key` lets any caller point the CDN's
 * `/cdn-cgi/image/` transform at an attacker-chosen origin (SSRF / open proxy)
 * or at an arbitrary key under the account's own store. A fixed literal, or a
 * key scoped by a server-trusted `ctx.*` value, is not recorded. Structurally
 * identical to `AdvisorImageDeliveryUrlAccess`.
 */
export interface ImageDeliveryUrlAccessIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `buildImageDeliveryUrl` call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `createAuth({...})` call's configuration snapshot — the shared input for
 * the five `auth_*` security lints (trusted-origins wildcard, CSRF check
 * disabled, secure cookies disabled, email verification disabled, session
 * freshAge zero). Matched by callee NAME (an `import`-agnostic, fail-closed
 * convention the other feeders share), so a re-export or alias still resolves.
 * When the config argument isn't a statically-analyzable object literal (a
 * top-level spread, or not an object literal at all), `analyzable` is `false`
 * and every boolean fact defaults to its SAFE (not-flagged) value — an opaque
 * config can't be relied on either way. Structurally identical to
 * `AdvisorAuthConfig`.
 */
export interface AuthConfigIR {
    /** `true` when the call's config argument was a static object literal the feeder could read. */
    analyzable: boolean;
    /** `advanced.disableCSRFCheck === true`. */
    disableCsrfCheck: boolean;
    /** `emailAndPassword.enabled === true`. */
    emailPasswordEnabled: boolean;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `createAuth(...)` call, or `0` when unknown. */
    line: number;
    // eslint-disable-next-line no-secrets/no-secrets -- the dotted config-path in the doc comment, not a credential
    /** `emailAndPassword.requireEmailVerification === true` present. */
    requireEmailVerification: boolean;
    /** `trustedOrigins` array literal contains a `"*"` element. */
    /** `plugins` includes `scim(...)` while `database` is a non-transactional Lunora adapter — a combination that throws at runtime. */
    scimOnNonTransactionalAdapter: boolean;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
    /** `advanced.useSecureCookies === false`. */
    secureCookiesDisabled: boolean;
    /** `session.freshAge === 0` (explicit literal). */
    sessionFreshAgeZero: boolean;
    trustedOriginsWildcard: boolean;
}

/**
 * One discovered `httpRoute.<verb>("/admin/…")` route on an admin/privileged-looking
 * path, with whether its builder chain references an auth/admin guard — the
 * `admin_route_without_guard` lint input. Structurally identical to
 * `AdvisorAdminRoute`.
 */
export interface AdminRouteIR {
    /** Export binding name of the route handler. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"POST"`. */
    method: string;
    /** The route path, e.g. `/admin/users`. */
    path: string;
    /** `true` when the handler body references an auth/session/admin guard (`ctx.auth`, `getSession`, `requireAdmin`, …). */
    usesGuard: boolean;
}

/**
 * One committed `wrangler.jsonc` `vars` entry whose value is a plaintext secret —
 * the `plaintext_secret_in_wrangler_vars` lint input. `vars` are baked into the
 * deployed Worker in cleartext and checked into source control, so a real API key
 * / token / private key there ships the secret to every reader of the repo and the
 * bundle; it belongs in a Secrets Store binding or `wrangler secret put`. Produced
 * by `@lunora/config` (which reads `wrangler.jsonc`), not a ts-morph feeder —
 * codegen only passes it through. Structurally identical to `AdvisorWranglerVariable`.
 */
export interface WranglerVariableIR {
    /** The `wrangler.jsonc` file the var was read from, relative to the project root. */
    file: string;
    /** The offending `vars` key (e.g. `STRIPE_SECRET_KEY`). */
    key: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `private_key` / `secret_named_var`. */
    kind: string;
    /** Redacted preview of the value (first few chars + length) for the finding detail — never the full secret. */
    preview: string;
}

/**
 * One `queues.producers[]` entry of `wrangler.jsonc`, from the top level or an
 * `env.<name>` block — how codegen learns a queue's per-environment name. Produced
 * by `@lunora/config` (which reads `wrangler.jsonc`); codegen only matches it to a
 * declared queue by `binding`.
 */
export interface WranglerQueueProducerIR {
    /** The `Queue` producer binding, e.g. `QUEUE_JOBS`. */
    binding: string;
    /** The `env.<name>` block the entry sits in; absent for the top level. */
    env?: string;
    /** The queue name that binding sends to in that scope, e.g. `jobs-preview`. */
    queue: string;
}

export interface ProjectIR {
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    /** Typed REST routes discovered from `httpRoute.<verb>(...)` builder chains. */
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    migrations: ReadonlyArray<MigrationIR>;
    schema: SchemaIR;
}
