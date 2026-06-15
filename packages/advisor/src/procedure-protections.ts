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
    /** `true` when the handler references `ctx.mail` / `ctx.email` (sends mail). */
    callsMail: boolean;
    /** The exported binding name of the procedure (e.g. `signUp`). */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Registration kind — `query` is read-only; `mutation`/`action` are write-shaped. */
    kind: "action" | "mutation" | "query";
    /** `true` when the chain carries `.use(verifyTurnstile(...))` or a `protectPublic({ captcha })` bundle. */
    usesCaptcha: boolean;
    /** `true` when the chain carries `.use(mask(...))`. */
    usesMask: boolean;
    /** `true` when the chain carries `.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle. */
    usesRateLimit: boolean;
    /** `true` when the chain carries `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` when the procedure uses `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
    /** `true` when the handler inserts into a user/session/account-shaped table. */
    writesUserTable: boolean;
}
