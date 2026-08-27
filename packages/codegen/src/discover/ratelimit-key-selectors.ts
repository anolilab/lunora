import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import { calleeName, enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { collectCallRows, limitNameOf, propertyInitializer } from "./discover-ast";
import type { RatelimitKeySelectorIR } from "./ir";

/** The `@lunora/ratelimit` middleware factories whose third argument carries a `key` selector. */
const RATELIMIT_CALLEES = new Set(["dbRateLimit", "rateLimit"]);

/**
 * The node {@link isArgumentDerived}/{@link isScopedByContext} should inspect for
 * a `key` selector — the arrow function's *body*, not the whole arrow function.
 * The selector is always `(ctx) => …`, and its parameter declaration is itself
 * textually named `ctx`; checking the whole node would make every selector
 * match {@link isScopedByContext} (the parameter identifier alone satisfies the
 * "somewhere references `ctx`" scan), even one whose body never reads `ctx`. A
 * concise-body arrow's `getBody()` is the return expression; a block-body
 * arrow's is the `{ … }` block — both exclude the parameter list.
 */
const selectorBody = (key: TsNode): TsNode => (Node.isArrowFunction(key) ? key.getBody() : key);

/**
 * The IR row for a `rateLimit(limiter, name, { key, … })` / `dbRateLimit(config,
 * name, { key, … })` call whose `key` selector is arg-derived and unscoped, or
 * `undefined`.
 */
const ratelimitKeySelectorInCall = (call: CallExpression, relativePath: string): RatelimitKeySelectorIR | undefined => {
    const callee = calleeName(call.getExpression());

    if (callee === undefined || !RATELIMIT_CALLEES.has(callee)) {
        return undefined;
    }

    const options = call.getArguments()[2];

    if (!options) {
        return undefined;
    }

    const key = propertyInitializer(options, "key");

    if (!key) {
        return undefined;
    }

    const body = selectorBody(key);

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx` reference anywhere in the selector's body — a
    // selector like `(ctx) => ctx.auth.userId` references `ctx` and is treated
    // as scoped, so it is not flagged. A selector with no `args` reference at all
    // (a fixed/global bucket) is not arg-derived either, so it is not flagged —
    // that "no key" case is deliberately out of scope for this lint.
    if (!isArgumentDerived(body) || isScopedByContext(body)) {
        return undefined;
    }

    return { callee, exportName: enclosingExportName(call), file: relativePath, limitName: limitNameOf(call), line: call.getStartLineNumber() };
};

/**
 * Discover `rateLimit(limiter, name, { key, … })` / `dbRateLimit(config, name, {
 * key, … })` calls (`@lunora/ratelimit`) in `lunora/` whose `key` selector is
 * derived from the handler's `args` with no server-side scoping — the
 * `ratelimit_key_spoofable_or_global` lint input. The middleware's `key` is `(ctx)
 * => string | undefined`: a sub-key isolating the limit per caller. A key an
 * attacker controls lets them rotate it per request and bypass the limit
 * entirely, defeating its purpose. A selector scoped by `ctx` (e.g.
 * `ctx.auth.userId`, `ctx.ip` — both server-trusted, never read from a client
 * header), or one with no `args` reference at all (a fixed/global bucket), is
 * not recorded; only an arg-derived, unscoped selector reaches here. Only a
 * direct object-literal third argument is inspected, and one finding is
 * produced per call.
 */
const discoverRatelimitKeySelectors = (project: Project, lunoraDirectory: string): RatelimitKeySelectorIR[] =>
    collectCallRows(project, lunoraDirectory, ratelimitKeySelectorInCall);

export default discoverRatelimitKeySelectors;
