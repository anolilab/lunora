import emit from "../../finding";
import type { Lint } from "../../types";
import { isPublicWrite, matchesNamePhrase } from "../helpers";

/**
 * Export-name phrases that strongly imply an abuse-sensitive endpoint —
 * surfaced in the detail to raise urgency.
 *
 * Matched as WORDS via {@link matchesNamePhrase}, not as substrings: a
 * substring scan tags `updatePresets` (`reset`) and `unsubscribeAll`
 * (`subscribe`) high-risk, and prose that overstates a benign finding costs the
 * same trust a false finding does.
 */
const SENSITIVE_PHRASES = [
    "contact",
    "forgot",
    "login",
    "logIn",
    "magic",
    "otp",
    "register",
    "reset",
    "signin",
    "signIn",
    "signup",
    "signUp",
    "subscribe",
    "verify",
];

/**
 * Flags a public `mutation`/`action` whose builder chain installs no rate limit.
 *
 * Every publicly-callable write is a flood target: without a `rateLimit`
 * middleware a single client can hammer it to exhaust D1 writes, send-mail quota,
 * or paid credits, and brute-force auth-shaped endpoints (login / reset / OTP).
 * Lunora ships `rateLimit()` (`@lunora/ratelimit`) and the `protectPublic({...})`
 * bundle for exactly this; this lint fires when neither is present on a public
 * write.
 *
 * Runs only when the codegen feeder supplies protection evidence
 * (`context.procedureProtections`); a runtime caller with no evidence flags
 * nothing. `query` is read-only and excluded; internal functions are
 * server-called and excluded.
 */
const publicMutationWithoutRatelimit: Lint = {
    categories: ["SECURITY"],
    description:
        "A public `mutation`/`action` has no `rateLimit` middleware. Publicly-callable writes are flood and brute-force targets — an attacker can exhaust writes, mail quota, or credits, or guess credentials on auth-shaped endpoints.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "public_mutation_without_ratelimit",
    remediation:
        'Attach a rate limit: `.use(rateLimit(limiter, "<bucket>"))` from `@lunora/ratelimit`, or wrap the recommended public-procedure guards with `.use(protectPublic({ rateLimit, captcha }))` from `@lunora/server`. Genuinely-open writes can be acknowledged by adding a permissive limiter.',
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        return context.procedureProtections
            .filter((procedure) => isPublicWrite(procedure) && !procedure.usesRateLimit)
            .map((procedure) => {
                const sensitive = matchesNamePhrase(procedure.exportName, SENSITIVE_PHRASES);

                return emit(publicMutationWithoutRatelimit, {
                    cacheKey: `public_mutation_without_ratelimit:${procedure.file}:${procedure.exportName}`,
                    detail: `Public ${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) has no rate limit${sensitive ? " — its name suggests an auth/abuse-sensitive endpoint, so this is high-risk" : ""}. Add \`.use(rateLimit(...))\` or \`.use(protectPublic({ rateLimit }))\`.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind, sensitive },
                });
            });
    },
    source: "static",
    title: "Public write without a rate limit",
};

export default publicMutationWithoutRatelimit;
