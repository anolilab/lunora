/**
 * One procedure (query / mutation / action) reduced to the protective middlewares
 * its builder chain installs plus the behavioural facts that decide whether a
 * guard is expected — the input the `public_mutation_without_ratelimit` and
 * `user_creating_mutation_without_captcha` lints consume. A `protectPublic({...})`
 * bundle is unwrapped by the feeder: its keys set `usesRateLimit`/`usesCaptcha`
 * exactly as the standalone `.use(...)` steps would. Produced by the codegen
 * feeder; runtime callers don't supply it, so the lints find nothing there.
 */
export interface AdvisorProcedureProtection {
    /**
     * `true` when the handler references `ctx.mail` / `ctx.email` (sends mail),
     * `undefined` when the feeder couldn't read the handler body (a genuinely
     * cross-file handler). `user_creating_mutation_without_captcha` treats
     * `undefined` the same as `true` — fail-closed, since an unreadable handler
     * might well send mail.
     */
    callsMail?: boolean;

    /** `true` when the handler emits a structured observability event (`ctx.log` / `ctx.span` / `ctx.trace`). */
    emitsEvent?: boolean;

    /**
     * `true` when the source carries a `// lunora-advisor-exempt` directive above
     * the export — the developer's explicit opt-out. The row still appears in the
     * map, marked `exempt`, but pulls no weight.
     */
    exempt?: boolean;
    /** The `-- reason` from the directive, so an exemption is argued rather than silent. */
    exemptReason?: string;
    /** The exported binding name of the procedure (e.g. `signUp`). */
    exportName: string;
    /**
     * `true` when the handler fans work out to a privileged, cost-bearing dispatch
     * surface (scheduler `runAfter`/`runAt`, a queue producer send, or a workflow
     * create). Read by the privileged-fanout lint, paired with public visibility
     * and no rate limit. `undefined` when the feeder couldn't read the handler
     * body — the lint treats that as `true` (fail-closed).
     */
    fanOut?: boolean;

    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** `true` when the handler wraps work in `try`/`catch`. */
    handlesErrors?: boolean;

    /**
     * `true` when the procedure declares an email-shaped argument. Read by the
     * `signup_mutation_without_disposable_gating` lint: `emailGateMiddleware`
     * gates an address selected off the args, so a procedure that never receives
     * one cannot action the lint no matter what table it writes.
     *
     * Optional so a feeder predating this field (or a runtime caller) is treated
     * as "unknown" rather than silently clearing every finding.
     */
    hasEmailArg?: boolean;
    /** Registration kind — `query` is read-only; `mutation`/`action` are write-shaped. */
    kind: "action" | "mutation" | "query";
    /** `true` when the handler runs any AI generation, bounded or not. */
    runsAiGeneration?: boolean;
    /** `true` when the handler reaches an outbound surface (`ctx.fetch`, mail, queues, storage, sql, ai, …) that can fail. */
    reachesOutbound?: boolean;
    /** `true` when the handler throws a bare `new Error(...)` rather than a coded `LunoraError`. */
    throwsBareError?: boolean;
    /**
     * `true` when the handler runs an AI generation (`generateText`/`streamText`/
     * `generateObject`/`streamObject`) with no `maxOutputTokens` bound. Read by
     * the `ai_unbounded_generation_public` lint (paired with public visibility).
     * `undefined` when the feeder couldn't read the handler body — the lint
     * treats that as `true` (fail-closed), distinct from the call-level opaque-
     * config case, which the feeder always reports as `false` (fail-open by
     * design — see `isUnboundedAiGeneration`).
     */
    unboundedAiGeneration?: boolean;
    /** `true` when the chain carries `.use(verifyTurnstile(...))` or a `protectPublic({ captcha })` bundle. */
    usesCaptcha: boolean;
    /** `true` when the chain carries `.use(emailGateMiddleware(...))` from `@lunora/auth`. Read by the `signup_mutation_without_disposable_gating` lint (paired with public visibility + a user-table write). */
    usesEmailGate: boolean;
    /**
     * `true` when the handler calls `ctx.db.insertManyUnsafe(...)`, which bypasses
     * validators and triggers. Read by the `insert_many_unsafe_user_data` lint
     * (paired with public visibility). `undefined` when the feeder couldn't read
     * the handler body — the lint treats that as `true` (fail-closed).
     */
    usesInsertManyUnsafe?: boolean;
    /** `true` when the chain carries `.use(mask(...))`. */
    usesMask: boolean;
    /** `true` when the chain carries `.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle. */
    usesRateLimit: boolean;
    /** `true` when the chain carries `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` when the procedure uses `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
    /**
     * `true` when the handler inserts into a user/session/account-shaped table,
     * `undefined` when the feeder couldn't read the handler body (a genuinely
     * cross-file handler). `signup_mutation_without_disposable_gating` and
     * `user_creating_mutation_without_captcha` treat `undefined` the same as
     * `true` — fail-closed, since an unreadable handler might well write one.
     */
    writesUserTable?: boolean;
}
