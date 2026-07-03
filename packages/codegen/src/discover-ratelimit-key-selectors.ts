import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { RatelimitKeySelectorIR } from "./ir";

/** The `@lunora/ratelimit` middleware factories whose third argument carries a `key` selector. */
const RATELIMIT_CALLEES = new Set(["dbRateLimit", "rateLimit"]);

/**
 * The simple callee name of a call expression — the trailing identifier for a
 * bare call (`rateLimit(...)`) or a member call (`ratelimit.rateLimit(...)` →
 * `rateLimit`). Matched by shape (an `import`-agnostic, fail-closed
 * convention, the same one the other feeders use), so a re-export or alias
 * still resolves.
 */
const calleeName = (expression: TsNode): string | undefined => {
    if (Node.isIdentifier(expression)) {
        return expression.getText();
    }

    if (Node.isPropertyAccessExpression(expression)) {
        return expression.getName();
    }

    return undefined;
};

/**
 * The initializer of a `key` property on `options`, or `undefined` when
 * `options` is not a direct object-literal argument, or has no `key` property
 * assignment. A shorthand `{ key }` is deliberately skipped — keeps the check
 * single-hop/low-FP, matching the other sink feeders.
 */
const keyInitializer = (options: TsNode): TsNode | undefined => {
    if (!Node.isObjectLiteralExpression(options)) {
        return undefined;
    }

    const property = options.getProperty("key");

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

/** The string-literal value of a call's second (`name`) argument, or `""` when it isn't one. */
const limitNameOf = (call: CallExpression): string => {
    const argument = call.getArguments()[1];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : "";
};

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

    const key = keyInitializer(options);

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

/** Arg-derived, unscoped `rateLimit`/`dbRateLimit` key selectors in one source file. */
const ratelimitKeySelectorsInSourceFile = (sourceFile: SourceFile, relativePath: string): RatelimitKeySelectorIR[] => {
    const found: RatelimitKeySelectorIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const selector = ratelimitKeySelectorInCall(call, relativePath);

        if (selector) {
            found.push(selector);
        }
    }

    return found;
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
const discoverRatelimitKeySelectors = (project: Project, lunoraDirectory: string): RatelimitKeySelectorIR[] => {
    const selectors: RatelimitKeySelectorIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        selectors.push(...ratelimitKeySelectorsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return selectors;
};

export default discoverRatelimitKeySelectors;
