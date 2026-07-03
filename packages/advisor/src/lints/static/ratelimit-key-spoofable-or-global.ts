import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `rateLimit`/`dbRateLimit` middleware call (`@lunora/ratelimit`) whose
 * `key` selector is derived from the handler's `args` with no server-side
 * scoping.
 *
 * The middleware's `key` is `(ctx) => string | undefined` — a sub-key that
 * isolates the limit per caller. When the selector reads straight from `args`
 * (an email, a client-supplied id, …) instead of a server-trusted identity
 * (`ctx.auth.userId`) or the server-trusted `ctx.ip`, an attacker can rotate the
 * key on every request and never share a bucket with themselves, defeating the
 * limit entirely. A selector with no `args` reference at all — a fixed/global
 * bucket, including simply omitting `key` — is a *different*, fuzzier problem
 * (one caller can still exhaust a shared global bucket for everyone) and is
 * deliberately **not** flagged here, to keep this lint's false-positive rate
 * low: a global bucket is a legitimate choice for some limits (e.g. a
 * deployment-wide cost cap), so its absence alone is not a reliable signal.
 *
 * Runs only when the codegen feeder supplies rate-limit key-selector evidence
 * (`context.ratelimitKeySelectors`); a runtime caller flags nothing. One finding
 * per arg-derived, unscoped selector.
 */
const ratelimitKeySpoofableOrGlobal: Lint = {
    categories: ["SECURITY"],
    description:
        "A `rateLimit`/`dbRateLimit` middleware call's `key` selector is derived from the handler's `args` with no server-side scoping, so an attacker can rotate the key on every request (e.g. by resubmitting a different email/id) and never share a bucket with themselves — the limit never actually limits them.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "ratelimit_key_spoofable_or_global",
    remediation:
        'Derive the rate-limit `key` from a server-trusted value — `ctx.auth.userId` for authenticated callers, `ctx.ip` for anonymous ones (e.g. `key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon"`) — instead of an `args` field the caller controls.',
    run: (context) => {
        if (context.ratelimitKeySelectors === undefined) {
            return [];
        }

        return context.ratelimitKeySelectors.map((selector) =>
            emit(ratelimitKeySpoofableOrGlobal, {
                cacheKey: `ratelimit_key_spoofable_or_global:${selector.file}:${selector.line.toString()}`,
                detail: `\`${selector.callee}(…, "${selector.limitName}", { key })\` in \`${selector.exportName}\` (${selector.file}:${selector.line.toString()}) derives its \`key\` from \`args\` with no server-side scoping — an attacker can rotate the key per request and bypass the limit. Derive \`key\` from \`ctx.auth.userId\` / \`ctx.ip\` instead.`,
                metadata: { callee: selector.callee, exportName: selector.exportName, file: selector.file, limitName: selector.limitName, line: selector.line },
            }),
        );
    },
    source: "static",
    title: "Rate-limit key derived from spoofable user input",
};

export default ratelimitKeySpoofableOrGlobal;
