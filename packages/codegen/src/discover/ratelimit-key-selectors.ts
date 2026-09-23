import type { CallExpression, Identifier, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { RatelimitKeySelectorIR } from "../ir";
import { collectCallRows, limitNameOf, optionsObjectLiteral, propertyInitializer } from "./ast";
import { calleeName } from "./callee";

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
 * The name of the selector's single parameter — `(ctx) => …` → `"ctx"` — or
 * `undefined` when it is destructured, absent, or not a plain identifier. The
 * name is freely chosen at the call site, so the analysis below reads it rather
 * than assuming the conventional `ctx`.
 */
const selectorParameterName = (key: TsNode): string | undefined => {
    if (!Node.isArrowFunction(key)) {
        return undefined;
    }

    const nameNode = key.getParameters()[0]?.getNameNode();

    return nameNode !== undefined && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
};

/**
 * True when `identifier` is the receiver of a `<identifier>.args` property
 * access — the caller's own payload hanging off the middleware context.
 */
const isArgsBagReceiver = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    return Node.isPropertyAccessExpression(parent) && parent.getExpression() === identifier && parent.getName() === "args";
};

/** Every reference to the selector's parameter inside its body. */
const parameterReferencesIn = (body: TsNode, parameterName: string): Identifier[] =>
    body.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
        if (identifier.getText() !== parameterName) {
            return false;
        }

        const parent = identifier.getParent();

        return !(Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier);
    });

/**
 * True when the selector derives its key from the call's arguments.
 *
 * The middleware hands the selector the *context*, and the validated call args
 * hang off it as `ctx.args` (see `@lunora/server`'s `withCallContext`). That is
 * the only spelling that compiles — a bare `args` identifier is not in scope at
 * module level, where these selectors are written — and it is invisible to
 * {@link isArgumentDerived}, which looks for a value reference to a binding
 * NAMED `args` while `ctx.args` is a property *name*. So the `<param>.args`
 * access is recognised here directly.
 */
const isSelectorArgumentDerived = (body: TsNode, parameterName: string | undefined): boolean =>
    isArgumentDerived(body) || (parameterName !== undefined && parameterReferencesIn(body, parameterName).some((identifier) => isArgsBagReceiver(identifier)));

/**
 * True when the selector reads a server-trusted value off its context — any use
 * of the parameter EXCEPT as the `<param>.args` bag, which is the caller's own
 * payload and is exactly what this lint hunts.
 *
 * Without that carve-out `ctx.args.email` was doubly silenced: not arg-derived
 * (a property name, not a value reference) *and* ctx-scoped (it mentions
 * `ctx`), so the only spelling a user can write could never be flagged.
 */
const readsTrustedContext = (body: TsNode, parameterName: string | undefined): boolean => {
    if (parameterName === undefined) {
        return isScopedByContext(body);
    }

    return parameterReferencesIn(body, parameterName).some((identifier) => !isArgsBagReceiver(identifier));
};

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

    // The options may be written inline or hoisted into a module-scope `const`
    // (`const byUser = { key: … }` — the spelling every example here uses).
    const key = propertyInitializer(optionsObjectLiteral(call.getArguments()[2]), "key");

    if (!key) {
        return undefined;
    }

    const body = selectorBody(key);
    const parameterName = selectorParameterName(key);

    // Arg-derived (`ctx.args.*`, or — in a destructured selector — through the
    // shared `args` taint) *and* reading nothing server-trusted off the context:
    // `(ctx) => ctx.auth.userId` is scoped, so it is not flagged. A selector with
    // no argument reference at all (a fixed/global bucket) is not arg-derived
    // either — that "no key" case is deliberately out of scope for this lint.
    if (!isSelectorArgumentDerived(body, parameterName) || readsTrustedContext(body, parameterName)) {
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
