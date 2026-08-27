import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { calleeName, enclosingExportName } from "./argument-taint";
import { collectCallRows, limitNameOf } from "./discover-ast";
import type { FailOpenGuardIR } from "./ir";

/**
 * Protective middleware factories that expose a `failOpen` escape hatch, mapped
 * to the 0-based index of the options-object argument that carries it. The
 * rate-limit factories put it third — `rateLimit(limiter, name, options)` /
 * `dbRateLimit(config, name, options)` — while the Turnstile guard takes a
 * single options object, `verifyTurnstileMiddleware(options)`. Matched by callee
 * name* (an `import`-agnostic, fail-closed match, the same convention the other
 * feeders use), so a re-export or alias still resolves.
 */
const OPTIONS_ARGUMENT_INDEX = new Map<string, number>([
    ["dbRateLimit", 2],
    ["rateLimit", 2],
    ["verifyTurnstileMiddleware", 0],
]);

/** The callee names that take a rate-limit `name` as their second string argument (the Turnstile guard has none). */
const RATE_LIMIT_CALLEES = new Set(["dbRateLimit", "rateLimit"]);

/**
 * Whether the options-object argument sets `failOpen: true` as a boolean
 * literal. A missing argument, a non-object argument, an absent `failOpen`, or a
 * non-literal initializer (`failOpen: cfg.x`) is conservatively treated as
 * fail-closed — the lint only ever fires on a provable `failOpen: true`.
 */
const setsFailOpenTrue = (options: TsNode | undefined): boolean => {
    if (!options || !Node.isObjectLiteralExpression(options)) {
        return false;
    }

    const property = options.getProperty("failOpen");

    return property !== undefined && Node.isPropertyAssignment(property) && property.getInitializer()?.getKind() === SyntaxKind.TrueKeyword;
};

/** The IR row for a `rateLimit`/`dbRateLimit`/`verifyTurnstileMiddleware` call, or `undefined` when the callee is none of those. */
const failOpenGuardInCall = (call: CallExpression, relativePath: string): FailOpenGuardIR | undefined => {
    const callee = calleeName(call.getExpression());

    if (callee === undefined) {
        return undefined;
    }

    const optionsIndex = OPTIONS_ARGUMENT_INDEX.get(callee);

    if (optionsIndex === undefined) {
        return undefined;
    }

    return {
        callee,
        exportName: enclosingExportName(call),
        failOpen: setsFailOpenTrue(call.getArguments()[optionsIndex]),
        file: relativePath,
        limitName: RATE_LIMIT_CALLEES.has(callee) ? limitNameOf(call) : "",
        line: call.getStartLineNumber(),
    };
};

/**
 * Discover rate-limit / Turnstile middleware calls in `lunora/` — the
 * `ratelimit_middleware_fail_open` lint input. Records every
 * `rateLimit(limiter, name, options)` / `dbRateLimit(config, name, options)`
 * (`@lunora/ratelimit`) and `verifyTurnstileMiddleware(options)`
 * (`@lunora/auth`) call, whether its options literal set `failOpen: true`, and
 * the rate-limit `name` (for the rate-limit factories). `failOpen: true` on a
 * guard means a store/siteverify outage silently admits every request; the lint
 * escalates that to a finding only when the guarded procedure looks
 * auth/payment-sensitive. Only a provable boolean-literal `failOpen: true` is
 * recorded as fail-open — everything else is treated as fail-closed.
 */
const discoverFailOpenGuards = (project: Project, lunoraDirectory: string): FailOpenGuardIR[] => collectCallRows(project, lunoraDirectory, failOpenGuardInCall);

export default discoverFailOpenGuards;
