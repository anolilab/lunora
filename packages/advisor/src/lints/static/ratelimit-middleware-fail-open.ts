import type { AdvisorFailOpenGuard } from "../../fail-open-guards";
import emit from "../../finding";
import type { Lint } from "../../types";
import { matchesNamePhrase } from "../helpers";

/**
 * Auth/payment-sensitive flow phrases. A guard on a procedure whose export name
 * or rate-limit `name` contains one of these as a WORD is the narrow,
 * high-precision subset where fail-open is dangerous — a limiter outage on a
 * sign-in / OTP / checkout endpoint becomes a brute-force or abuse window.
 *
 * Matched through {@link matchesNamePhrase} rather than as substrings: a
 * substring scan flags `updatePresets` (`reset`), `snapshotPrune` and
 * `listSlotProfiles` (`otp`), which is exactly the noise a lint documenting
 * itself as high-precision must not produce. The one-word spellings sit beside
 * the camelCase ones because they tokenize differently (`loginHandler` shares no
 * word with `logIn`).
 */
const SENSITIVE_PHRASES = ["signin", "signIn", "signup", "signUp", "login", "logIn", "register", "reset", "password", "otp", "verify", "payment", "checkout"];

/** Whether either the guarded procedure's export name or its rate-limit `name` looks auth/payment-sensitive. */
const guardsSensitiveFlow = (row: AdvisorFailOpenGuard): boolean =>
    matchesNamePhrase(row.exportName, SENSITIVE_PHRASES) || matchesNamePhrase(row.limitName, SENSITIVE_PHRASES);

/**
 * Flags a `rateLimit`/`dbRateLimit`/`verifyTurnstileMiddleware` guard configured
 * `failOpen: true` on an auth/payment-sensitive procedure.
 *
 * `@lunora/ratelimit`'s `rateLimit`/`dbRateLimit` and `@lunora/auth`'s
 * `verifyTurnstileMiddleware` fail **closed** by default — a store outage or a
 * failed Turnstile siteverify rejects the request (503). Passing `failOpen: true`
 * inverts that: the middleware swallows the failure and admits the request. On a
 * sign-in / account-creation / password-reset / OTP / payment endpoint that turns
 * a transient limiter outage into an unthrottled brute-force / abuse window.
 *
 * Runs only when the codegen feeder supplies fail-open-guard evidence
 * (`context.failOpenGuards`); a runtime caller flags nothing. Deliberately narrow
 * — fires only when the options literal provably set `failOpen: true` AND the
 * guarded procedure's export name or rate-limit `name` carries an auth/payment
 * WORD, keeping the false-positive rate low. One finding per guard.
 */
const ratelimitMiddlewareFailOpen: Lint = {
    categories: ["SECURITY"],
    description:
        "A rate-limit or Turnstile middleware guarding a sensitive auth/payment procedure is configured `failOpen: true`, so a limiter store outage or a failed Turnstile siteverify silently admits every request — turning a transient failure into an unthrottled brute-force / abuse window.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ratelimit_middleware_fail_open",
    remediation:
        "Drop `failOpen: true` (the default is fail-closed) on the rate-limit / Turnstile guard for auth and payment flows, or move the escape hatch to a non-sensitive procedure. Prefer rejecting traffic with a 503 over admitting unlimited unauthenticated attempts when the limiter or siteverify is unavailable.",
    run: (context) => {
        if (context.failOpenGuards === undefined) {
            return [];
        }

        return context.failOpenGuards
            .filter((row) => row.failOpen && guardsSensitiveFlow(row))
            .map((row) =>
                emit(ratelimitMiddlewareFailOpen, {
                    cacheKey: `ratelimit_middleware_fail_open:${row.file}:${row.line.toString()}`,
                    detail: `\`${row.callee}(...)\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) sets \`failOpen: true\` while guarding a sensitive flow — a limiter/siteverify outage then admits every request instead of rejecting it.`,
                    metadata: { callee: row.callee, exportName: row.exportName, file: row.file, limitName: row.limitName, line: row.line },
                }),
            );
    },
    source: "static",
    title: "Fail-open rate-limit / CAPTCHA guard on a sensitive procedure",
};

export default ratelimitMiddlewareFailOpen;
