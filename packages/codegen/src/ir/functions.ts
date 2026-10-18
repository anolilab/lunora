/**
 * Functions, procedures, shapes, identity, and the mutators and middleware they use.
 */
import type { CallSiteScope } from "./call-sites";
import type { ExposeCacheIR, ValidatorIR } from "./schema";

export interface FunctionIR {
    /**
     * Set when the chain carries `.use(platformAdmin(...))`: only a platform admin
     * can reach the procedure, so its writes are trusted to name any account.
     */
    adminOnly?: true;

    args: Record<string, ValidatorIR>;

    /** A channel registration: a `defineRoom` and its room name. Absent on every other registration. */
    channel?: { kind: "room"; name: string };

    exportName: string;

    /**
     * Set by the `.expose({ rest: true })` builder modifier (plan 167). When
     * `rest` is `true` the function is published on the public REST surface, so the
     * OpenAPI emitter describes it as a real `/_lunora/rest/<namespace>/<fn>` path
     * (the single source of truth the runtime router also derives from). Absent →
     * RPC-only (the default; not on the REST surface).
     *
     * `cache` mirrors the `RestCacheConfig` the runtime turns into response
     * headers, so the emitted spec can document the `Cache-Control` a caller will
     * actually observe. Only statically-readable literal fields are carried; a
     * computed value is simply absent (the spec under-documents rather than lies).
     */
    expose?: { cache?: ExposeCacheIR; rest?: boolean };

    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "messages". */
    filePath: string;

    kind: "action" | "mutation" | "query" | "stream";

    /**
     * Set on lifecycle hooks (`onConnect`/`onDisconnect`/`onShardInit`/
     * `onQueryChange`/`onWhisper`), on a `defineRoom` registration, and on a
     * `defineWebSocket` route: the moment the hook fires on. Such a function is
     * also an internal registration (so it lands in `LUNORA_FUNCTIONS` for path
     * dispatch) — a mutation for every moment except `whisper`, which is a
     * query; emit additionally collects the socket moments into the
     * `LUNORA_LIFECYCLE_HOOKS` manifest keyed by this moment, a `room`
     * registration into the `LUNORA_ROOMS` topic→path map, and a `socket` route
     * into the `LUNORA_SOCKETS` path→registration map. Absent on ordinary
     * functions.
     */
    lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "socket" | "whisper";

    /**
     * The `.output(validator)` declaration, when the chain has one.
     *
     * Takes precedence over {@link FunctionIR.returnType} (the handler's
     * inferred type) for the emitted `FunctionReference`. `.output()` is what
     * validates at runtime and what a reader takes as the contract, so the two
     * must agree — see the emit-side note for what went wrong when they did not.
     */
    output?: ValidatorIR;

    /**
     * Serialized TS source for the handler's return type, with `Promise<T>`
     * unwrapped so callers see `T` directly. Defaults to `"unknown"` when
     * ts-morph cannot resolve the type (typically because the consuming
     * project lacks a tsconfig that can reach `@lunora/server`).
     */
    returnType: string;

    /**
     * Call surface the function is exposed on. Absent (or `"public"`) means it
     * lands in the generated `api`; `"internal"` routes it to the separate
     * `internal` object and is rejected by the DO's external RPC path.
     */
    visibility?: "internal" | "public";

    /**
     * Literal price from `.x402({ price })`. Lazy registry output needs this
     * before importing the procedure module so the origin can paywall every
     * transport synchronously; a missing price means the source was dynamic.
     */
    x402?: { price?: number | string };
}

/**
 * A `defineShape({...})` declaration discovered in `lunora/shapes.ts`
 * (local-first sync engine, Phase 7). The emitted `LUNORA_SHAPES` registry keys
 * on {@link ShapeIR.exportName}; the generated DO's `resolveShape` override
 * dispatches a `shape_subscribe` to the matching registered shape. Discovery is
 * marker-driven (the `__lunoraShape` brand) — no field metadata is lifted here
 * because the runtime object (`columns`/`compileWhere`) carries the authority.
 */
export interface ShapeIR {
    /**
     * The shape's `args` validator map — its partition selector. Lifted so
     * `_generated/collections.ts` can type the selector a caller passes instead of
     * widening it to `Record<string, unknown>`. `{}` for a parameterless shape.
     */
    args: Record<string, ValidatorIR>;
    /** Export binding name — the shape's registry key and import member. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension — always `"shapes"`. */
    filePath: string;

    /**
     * The `table` string literal from the `defineShape({ table })` call, lifted
     * only for static advisor lints (the runtime object stays authoritative).
     * `undefined` when `table` is not a plain string literal — lints skip those.
     */
    table?: string;
}

/**
 * The single `defineIdentity({...})` claim contract discovered in
 * `lunora/identity.ts`. Discovery is **marker-driven** (the `__lunoraIdentity`
 * brand, exactly like {@link ShapeIR}) — no claim metadata is lifted here
 * because the emitted `_generated/server.ts` recovers the claim *type* from the
 * declaration itself (`InferIdentity` over the contract's `typeof`), and the
 * runtime object (`validate`/`onInvalid`) carries the authority at the boundary.
 * Exactly one per app; absent ⇒ generated output is byte-identical to today.
 */
export interface IdentityIR {
    /** Export binding name — the namespace member `_generated/server.ts` reads via `typeof`. */
    exportName: string;
}

/**
 * The single `defineEnv({...})` contract discovered in `lunora/env.ts`. Like
 * {@link IdentityIR}, only the export binding is lifted — the emitted
 * `_generated/server.ts` recovers the validated shape from the declaration
 * itself (`ReturnType` over the accessor's `typeof`), and the generated ShardDO
 * applies the same accessor to the worker `env` at ctx-build time to populate
 * `ctx.env`. Exactly one per app; absent ⇒ generated output is byte-identical.
 */
export interface EnvIR {
    /** Export binding name — the namespace member `_generated/server.ts` reads via `typeof`. */
    exportName: string;
}

/**
 * A `defineMutator({...})` declaration discovered in `lunora/mutators.ts`
 * (local-first sync engine, Phase 7). The emitted registry registers the
 * authoritative `server` impl into the DO's `LUNORA_FUNCTIONS` table (so
 * `handleRpc` transaction-wraps it) and records its path in
 * `LUNORA_MUTATOR_PATHS` so the DO's `isCustomMutator` override routes the
 * client-watermark push protocol. The client `client` impl is split into the
 * browser bundle separately — only the path crosses to the server side.
 */
export interface MutatorIR {
    /**
     * The mutator's `args` validator map, parsed exactly as a procedure's is, so
     * the emitted `api.mutators.<name>` reference carries the arg type a client
     * `defineMutator` infers instead of restating. `{}` for a parameterless
     * mutator (or one whose `args` isn't an inline object literal).
     */
    args: Record<string, ValidatorIR>;
    /** Export binding name — the mutator's registry key and import member. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension — always `"mutators"`. */
    filePath: string;

    /** 1-based line of the `defineMutator(...)` call, for diagnostics and advisor findings. */
    line: number;

    /**
     * The ownership column the declaration scopes the write to
     * (`defineMutator({ owner: "userId" })`), or `undefined` when it declares
     * none — which is also what the `mutator_without_owner_scope` lint reports,
     * since an unowned mutator is a public write endpoint. Only a string-literal
     * `owner` is lifted; a computed one reads as `undefined` rather than guessed.
     */
    owner?: string;

    /**
     * Serialized TS source for the authoritative `server` impl's return type,
     * `Promise<T>` unwrapped. `"unknown"` when ts-morph can't resolve it — same
     * contract as {@link FunctionIR.returnType}.
     */
    returnType: string;
}

/**
 * A whole-row `ctx.db.replace(id, document)` write discovered inside a custom
 * mutator's inline `server` impl (`lunora/mutators.ts`) — the input the
 * `mutator_full_row_replace` advisor lint consumes. A `replace` overwrites the
 * entire row, so a concurrent edit to a different column on a synced table is
 * clobbered; `ctx.db.patch(id, { field })` merges at the column level instead.
 * Structurally identical to `AdvisorMutatorWrite` so it passes straight through
 * to the advisor without conversion, exactly as `InsertWriteIR` does for
 * `AdvisorInsertWrite`.
 */
export interface MutatorWriteIR {
    /** The mutator export whose `server` impl performs the replace, e.g. `renameChannel`. */
    exportName: string;
    /** Openable source path the replace appears in — always `lunora/mutators.ts`. */
    file: string;
    /** 1-based line of the `replace(...)` call. */
    line: number;
}

/**
 * Where a queue or workflow `handler:` passed by reference is declared, when it is
 * exported from a lunora source file — `defineWorkflow({ handler: onboard })` with
 * `onboard` exported from `lunora/onboarding/flow.ts` gives
 * `{ exportName: "onboard", file: "onboarding/flow" }`. The architecture graph
 * attributes that export's own call sites to the queue or workflow node, so its
 * calls are not reported as "not a registered function". `exportName` is the
 * exported name (`export { run as start }` → `start`).
 */
export interface HandlerSiteIR {
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
}

/**
 * A typed REST route declared with the `httpRoute.<verb>("/path")…` builder in
 * `@lunora/server` and mounted on `httpRouter()`. Captured statically from the
 * builder chain so the OpenAPI emitter can render a real `paths` entry: the verb
 * + path become the operation's method + URL, and the accumulated validator maps
 * become its query parameters, path parameters, and request body.
 */
export interface HttpRouteIR {
    /** `v.*` validators decoding the JSON request body (`.body({...})`), keyed by field. */
    body: Record<string, ValidatorIR>;

    /**
     * Rendered TS type of one SSE chunk — the `R` the `.stream(handler)`
     * handler yields — inferred from the handler via the type checker. Present
     * only when {@link HttpRouteIR.stream} is `true`; `"unknown"` when the
     * checker can't resolve enough context. Feeds the emitted
     * `HttpStreamRef<Chunk, …>` so the chunk type flows to the client.
     * @experimental Part of the HTTP-SSE stream surface (the `httpStreams.*` emission).
     */
    chunkType?: string;
    /** Export binding name of the route handler (used only for diagnostics / dedupe). */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "http". */
    filePath: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"GET"`. */
    method: string;
    /** The `.output(validator)` return schema when declared; absent ⇒ TS-inferred / best-effort. */
    output?: ValidatorIR;
    /** `v.*` validators decoding the hono path params (`.params({...})`), keyed by `:name`. */
    params: Record<string, ValidatorIR>;
    /** The route path passed to `httpRoute.<verb>(path)`, e.g. `/api/todos/:id`. */
    path: string;
    /** `v.*` validators decoding the URL query string (`.searchParams({...})`), keyed by name. */
    searchParams: Record<string, ValidatorIR>;
    /** `true` when declared via the terminal `.stream(...)` (Server-Sent Events) rather than `.handler(...)`. */
    stream: boolean;
}

/**
 * Per-procedure protective-middleware snapshot, produced by
 * `discoverProcedureMiddleware` for the security lints
 * (`public_mutation_without_ratelimit`, `user_creating_mutation_without_captcha`).
 * Records which `.use(...)` guards a procedure's builder chain carries plus the
 * behavioural facts that decide whether a guard is *expected* (does it write a
 * user/session table, does it send mail). `protectPublic({ rateLimit, captcha })`
 * is unwrapped: the bundle's object-literal keys set `usesRateLimit`/`usesCaptcha`
 * exactly as the individual `.use(rateLimit(...))` / `.use(verifyTurnstile(...))`
 * steps would. Structurally identical to `AdvisorProcedureProtection` so values
 * pass straight through to the advisor without conversion.
 */
export interface ProcedureMiddlewareIR {
    /**
     * `true` when the handler body could be read statically — an inline function
     * expression/arrow, or a same-file identifier resolved to one. `false` for a
     * genuinely cross-file handler (an imported function, or an identifier that
     * doesn't resolve in this file), in which case every behavioural fact below
     * is `undefined` rather than a false "not observed" — the feeder never saw
     * the body, so it has nothing to report.
     */
    analyzableBody: boolean;
    /** `true` when the handler (or a helper inside it) references `ctx.mail` / `ctx.email`. `undefined` when `analyzableBody` is `false`. */
    callsMail?: boolean;
    /** `true` when the handler emits a structured observability event (`ctx.log` / `ctx.span` / `ctx.trace`). */
    emitsEvent?: boolean;
    /** `true` when a `// lunora-advisor-exempt` directive sits above the export. */
    exempt: boolean;
    /** The `-- reason` from that directive, or `""`. */
    exemptReason: string;
    /** Export binding name of the procedure (e.g. `signUp`). */
    exportName: string;
    /** `true` when the handler fans work out to a privileged, cost-bearing dispatch surface (scheduler `runAfter`/`runAt`, a queue producer send, or a workflow create). Feeds the privileged-fanout lint. `undefined` when `analyzableBody` is `false`. */
    fanOut?: boolean;

    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** `true` when the handler wraps work in `try`/`catch`. */
    handlesErrors?: boolean;

    /**
     * `true` when the procedure declares an email-shaped argument (`email`,
     * `emailAddress`, `userEmail`, …), `false` when it provably declares none,
     * and **absent** when the argument list can't be read statically (a
     * `.input(sharedSchema)`, a spread, or a factory whose `args` comes from a
     * variable). Feeds `signup_mutation_without_disposable_gating`, which can
     * only be actioned when there is an address to gate — so "unreadable" must
     * stay distinguishable from "none", or the lint would clear itself on a
     * registration that may well expose one.
     */
    hasEmailArg?: boolean;
    kind: "action" | "mutation" | "query";
    /** `true` when the handler reaches an outbound surface (`ctx.fetch`, mail, queues, storage, sql, ai, …) that can fail. */
    reachesOutbound?: boolean;
    /** `true` when the handler runs any AI generation, bounded or not. */
    runsAiGeneration?: boolean;
    /** `true` when the handler throws a bare `new Error(...)` rather than a coded `LunoraError`. */
    throwsBareError?: boolean;
    /** `true` when the handler runs an AI generation (`generateText`/`streamText`/`generateObject`/`streamObject`) with no `maxOutputTokens` bound in its config literal. Feeds the `ai_unbounded_generation_public` lint. `undefined` when `analyzableBody` is `false`. */
    unboundedAiGeneration?: boolean;
    /** `true` when the chain carries `.use(verifyTurnstile(...))` or a `protectPublic({ captcha })` bundle. */
    usesCaptcha: boolean;
    /** `true` when the chain carries `.use(emailGateMiddleware(...))` (`@lunora/auth`). Feeds the `signup_mutation_without_disposable_gating` lint. */
    usesEmailGate: boolean;
    /** `true` when the handler calls `ctx.db.insertManyUnsafe(...)`, bypassing validators and triggers. Feeds the `insert_many_unsafe_user_data` lint. `undefined` when `analyzableBody` is `false`. */
    usesInsertManyUnsafe?: boolean;
    /** `true` when the chain carries `.use(mask(...))`. */
    usesMask: boolean;
    /** `true` when the chain carries `.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle. */
    usesRateLimit: boolean;
    /** `true` when the chain carries `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
    /** `true` when the handler inserts into a user/session/account-shaped table. `undefined` when `analyzableBody` is `false`. */
    writesUserTable?: boolean;
}

/**
 * Per-procedure argument-validator snapshot, produced by the
 * argument-validator discoverer for the input-hardening lints
 * (`public_arg_uses_any`, `unbounded_string_arg`). Only public procedures are
 * recorded — internal functions take server-trusted input. Structurally identical
 * to `AdvisorArgumentValidator` so it passes straight through to the advisor
 * without conversion.
 */
export interface ArgumentValidatorIR {
    /** Arg names declared as `v.any()` (unvalidated, untyped input). */
    anyArgs: string[];
    /** Export binding name of the procedure (e.g. `updateProfile`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the registration call, or `0` when unknown. */
    line: number;
    /** Arg names declared as `v.string()` with no statically-visible max-length bound. */
    unboundedStringArgs: string[];
}

/**
 * One factory/constructor call in `lunora/` whose config object literal a
 * security lint inspects for a present-or-absent key — the shared input for the
 * config-call security lints (payment authorize, inbound-mail verify, rate-limit
 * store, browser private-targets). Structurally identical to `AdvisorConfigCall`
 * so it passes straight through to the advisor without conversion.
 */
export interface ConfigCallIR {
    /** `true` when the config argument was a static object literal the feeder could read. */
    analyzable: boolean;
    /** The factory function or constructor name at the call site, e.g. `createPayment` / `RateLimiter`. */
    callee: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the call site, or `0` when unknown. */
    line: number;
    /** Keys present in the config object literal (empty when not `analyzable`). */
    presentKeys: string[];
    /** Keys in the config object literal explicitly assigned the literal `true`. */
    trueKeys: string[];
}

/**
 * One secret-shaped string literal discovered in `lunora/` source — the
 * `hardcoded_secret` lint input. Complements the pre-commit `vis secrets` scan by
 * surfacing the same class of finding in-IDE via the studio Advisors table.
 * Structurally identical to `AdvisorSecretLiteral`.
 */
export interface SecretLiteralIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `aws_access_key` / `pem_private_key` / `high_entropy`. */
    kind: string;
    /** 1-based line of the literal, or `0` when unknown. */
    line: number;
    /** Redacted preview of the literal (first few chars + length) for the finding detail — never the full secret. */
    preview: string;
}

/**
 * One `ctx.sql.query(text, …)` / `ctx.sql.unsafe(text, …)` call whose `text`
 * argument is built in place rather than passed as a fixed statement — the
 * `sql_injection_risk` lint input. The Hyperdrive driver binds ONLY the `params`
 * array; the `text` string is spliced verbatim into the SQL, so a `text` assembled
 * from a string concatenation or a substitution template literal is an injection
 * vector. A fixed string literal / no-substitution template is safe. Structurally
 * identical to `AdvisorSqlInterpolation`.
 */
export interface SqlInterpolationIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the interpolation, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `ctx.fetch(url, …)` call inside an action whose URL argument is derived
 * from the handler's `args` — the `action_fetch_ssrf` lint input. `ctx.fetch` is
 * the action-only outbound-request escape hatch with no host allowlist, so a URL
 * assembled from request input is a server-side request forgery vector (cloud
 * metadata endpoints, internal services). Only arg-derived URLs reach here; a
 * fixed literal or a URL built from config/`ctx.*` is not recorded. Structurally
 * identical to `AdvisorArgumentDerivedFetch`.
 */
export interface ArgumentDerivedFetchIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.fetch` call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}

/**
 * One `query` handler whose `return` hands back the raw rows of a table — the
 * result of a `ctx.db.<table>.findMany()` / `.findFirst()` / `.get()` read, or a
 * `ctx.db.query("<table>")…collect()` fluent chain — returned directly (or through
 * one local `const` hop) with no hand-built projection. The
 * output_projection_missing_on_public_read lint keeps only `visibility ===
 * "public"` rows with no `.output(...)` / `.use(mask(...))` on the chain, then
 * joins `table` against the schema and flags one whose columns are PII-named.
 * Structurally identical to `AdvisorRawRowReturn` so values pass straight through
 * without conversion.
 */
export interface RawRowReturnIR {
    /** Export binding name of the query returning the raw rows. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `return` (or concise-body) expression. */
    line: number;
    /** Table whose raw rows are returned, or `""` when the read's table wasn't a string literal. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(mask(...))` step. */
    usesMask: boolean;
    /** `true` when the procedure's builder chain carries an `.output(...)` return-shape projection. */
    usesOutput: boolean;
    /** `"internal"` for `internalQuery`; `"public"` for `query`. */
    visibility: "internal" | "public";
}
