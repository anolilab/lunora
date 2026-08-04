import type { Identifier, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/**
 * True when `identifier` is a *value* reference to the handler's `args` binding —
 * the taint root shared by every Wave 3 argument-taint feeder. Excludes the
 * trailing `.args` of a member access and the key of an explicit `{ args: … }`
 * property, which name a different `args` and carry no taint; a `{ args }`
 * shorthand IS a value reference and is kept.
 */
const isArgsValueReference = (identifier: Identifier): boolean => {
    if (identifier.getText() !== "args") {
        return false;
    }

    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier);
};

/**
 * True when `identifier` is a *value* reference to the handler's `ctx` binding —
 * the server-trusted root. Mirror of {@link isArgsValueReference}: excludes the
 * trailing `.ctx` of a member access and the key of an explicit `{ ctx: … }`
 * property; a `{ ctx }` shorthand IS a value reference and is kept.
 */
const isContextValueReference = (identifier: Identifier): boolean => {
    if (identifier.getText() !== "ctx") {
        return false;
    }

    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier);
};

/** True when `node` is, or textually contains, a value reference to the `ctx` binding. */
const textuallyReferencesContext = (node: TsNode): boolean => {
    if (Node.isIdentifier(node)) {
        return isContextValueReference(node);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isContextValueReference(identifier));
};

/**
 * True when `identifier` is a *value* reference to an `httpAction` handler's
 * request parameter — the taint root the `args`/`ctx` helpers never reach, because
 * the request arrives as a positional parameter the user names freely
 * (`request` / `req` / `r`) rather than a fixed `args`/`ctx` binding. Mirror of
 * {@link isArgsValueReference} with a dynamic root name: excludes the trailing
 * `.<requestName>` of a member access and the key of an explicit
 * `{ <requestName>: … }` property; a `{ request }` shorthand IS a value reference.
 */
const isRequestValueReference = (identifier: Identifier, requestName: string): boolean => {
    if (identifier.getText() !== requestName) {
        return false;
    }

    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier);
};

/**
 * The leftmost identifier of a member/element-access (and non-null) chain
 * (`body.tag.id` → `body`), or `undefined` when the chain doesn't root at a bare
 * identifier. Lets the request taint follow one hop through the *object* of a
 * member access (`const body = await request.json(); … body.tag`), which the
 * bare-identifier {@link singleHopInitializer} hop alone cannot reach.
 */
const memberAccessRootIdentifier = (node: TsNode): Identifier | undefined => {
    let current: TsNode = node;

    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current) || Node.isNonNullExpression(current)) {
        current = current.getExpression();
    }

    return Node.isIdentifier(current) ? current : undefined;
};

/**
 * The simple callee name of a call/`new` expression's *callee* node — the bare
 * identifier (`createPayment`) or the trailing member name of a property access
 * (`payment.createPayment` → `createPayment`), else `undefined`. The shared
 * `import`-agnostic, fail-closed name match every config/argument feeder uses, so
 * a re-export or alias still resolves.
 */
export const calleeName = (expression: TsNode): string | undefined => {
    if (Node.isIdentifier(expression)) {
        return expression.getText();
    }

    if (Node.isPropertyAccessExpression(expression)) {
        return expression.getName();
    }

    return undefined;
};

/** True when `node` is, or textually contains, a value reference to the `args` binding. */
export const referencesArgs = (node: TsNode): boolean => {
    if (Node.isIdentifier(node)) {
        return isArgsValueReference(node);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isArgsValueReference(identifier));
};

/**
 * When `node` is a bare identifier bound by a `const key = args.key` in the enclosing
 * handler, return that initializer so a *single* extra hop of taint can be checked
 * (`const key = args.key; … key`); otherwise `undefined`. Only same-function
 * declarations are followed — the taint stays deliberately single-hop.
 */
export const singleHopInitializer = (node: TsNode): TsNode | undefined => {
    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const name = node.getText();
    const enclosingFunction = node.getFirstAncestor(
        (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
    );

    if (enclosingFunction === undefined) {
        return undefined;
    }

    // The nearest same-named `const` declared *before* this use. A declaration that
    // follows the use — or a shadowing one in a sibling branch — can't be its source,
    // so preferring the closest preceding binding avoids resolving through a shadow.
    // (Exact symbol resolution would need the type-checker these pre-`pnpm install`
    // feeders deliberately run without, so scope-order is the closest safe proxy.)
    const usePosition = node.getStart();
    let nearest: TsNode | undefined;
    let nearestPosition = -1;

    for (const variable of enclosingFunction.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (variable.getName() !== name) {
            continue;
        }

        const initializer = variable.getInitializer();
        const declarationPosition = variable.getStart();

        if (initializer !== undefined && declarationPosition < usePosition && declarationPosition > nearestPosition) {
            nearest = initializer;
            nearestPosition = declarationPosition;
        }
    }

    return nearest;
};

/**
 * True when `expression` is derived from the handler's `args` — directly (`args.x`,
 * a template / `new URL(...)` / helper call embedding `args.*`) or through one local
 * hop (`const key = args.key; … key`). This is the shared taint predicate every
 * Wave 3 sink feeder (SSRF fetch, owner-field write, storage/kv IDOR) reads.
 */
export const isArgumentDerived = (expression: TsNode): boolean => {
    if (referencesArgs(expression)) {
        return true;
    }

    const initializer = singleHopInitializer(expression);

    return initializer !== undefined && referencesArgs(initializer);
};

/**
 * True when `expression` — or its single-hop initializer — is NOT itself a call
 * (a `CallExpression` or `new` expression) that could transform the value before
 * it reaches the sink. `isArgumentDerived` deliberately also matches "a helper
 * call embedding `args.*`" (e.g. `hash(args.key)`, `deriveKey(args)`) so taint
 * detection stays fail-open; that is right for most sinks, but wrong for a rule
 * whose entire premise is that the caller controls the exact bytes reaching the
 * sink. A content-addressed key — the return of a server-side `storeFile(...)`
 * helper, itself the SHA-256 of the uploaded bytes — textually references
 * `args` (it IS the arg) yet is not attacker-chosen, because the call in
 * between recomputed it from data the server already trusts.
 *
 * Only a direct member/element-access chain, a template literal, or a binary
 * concatenation reaches here as "unmodified" — a wrapping call anywhere between
 * the sink argument and its (at most single-hop) `args`/`ctx` root means the
 * value was derived, not merely forwarded, so the rule should not treat it as
 * caller-controlled input reaching the sink verbatim.
 */
export const isUnmodifiedArgumentPassthrough = (node: TsNode): boolean => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
        return false;
    }

    const initializer = singleHopInitializer(node);

    return initializer === undefined || !(Node.isCallExpression(initializer) || Node.isNewExpression(initializer));
};

/**
 * True when `node` is scoped by a server-trusted `ctx` value — directly, through
 * one local `const` hop (symmetric with {@link isArgumentDerived}), or through a
 * locally-bound ctx identity composed into the key. A storage/kv key such as
 * `${ctx.auth.userId}/${args.name}` references *both* `args` and `ctx`; the IDOR
 * sinks treat any key that reaches `ctx` — even via `const k = scoped; … k` — as
 * scoped rather than attacker-controlled, so a correctly-prefixed key is not
 * flagged.
 *
 * The recommended remediation is usually written through an intermediate binding —
 * `const userId = ctx.auth.userId; … `${userId}/${args.name}`` — which puts the
 * ctx value *two* hops from the sink: one hop expands the key to its template, and
 * the identity reaches `ctx` only through the `userId` binding. So after the direct
 * and single-hop checks, each value-identifier composed into the key is followed
 * one hop to its own initializer, treating a key built from a ctx-derived local as
 * scoped. This only ever *suppresses* a finding (a fail-safe under-report), never
 * introduces one.
 */
export const isScopedByContext = (node: TsNode): boolean => {
    if (textuallyReferencesContext(node)) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    if (initializer !== undefined && textuallyReferencesContext(initializer)) {
        return true;
    }

    // Follow each value-identifier composed into the (expanded) key one hop to its
    // own `const` initializer — `${userId}/…` reaches ctx via `const userId = ctx.*`.
    const composed = initializer ?? node;
    const identifiers = Node.isIdentifier(composed) ? [composed] : composed.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some((identifier) => {
        const boundInitializer = singleHopInitializer(identifier);

        return boundInitializer !== undefined && textuallyReferencesContext(boundInitializer);
    });
};

/**
 * True when `node` is, or textually contains, a value reference to the `httpAction`
 * request parameter `requestName`. The request-rooted analog of
 * {@link referencesArgs}: catches `request.headers.get("x")`,
 * `new URL(request.url).searchParams.get("q")`, and `await request.json()`, which
 * the `args`-rooted feeders can't see (an HTTP handler receives a raw `Request`,
 * not the validated `args` object).
 */
export const referencesRequestInput = (node: TsNode, requestName: string): boolean => {
    if (Node.isIdentifier(node)) {
        return isRequestValueReference(node, requestName);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isRequestValueReference(identifier, requestName));
};

/**
 * True when `node` is derived from the `httpAction` request parameter — directly,
 * through one local `const` hop (`const h = request.headers; h.get("x")`), or
 * through one hop on the *root* of a member access (`const body = await
 * request.json(); … body.tag`). Symmetric with {@link isArgumentDerived}, plus the
 * member-root hop so a reflected request *body* value (always bound to a `const`
 * before its fields are read) is reached. Deliberately bounded to a single hop —
 * an unreached case is a fail-safe under-report, not a false negative that matters.
 */
export const isRequestInputDerived = (node: TsNode, requestName: string): boolean => {
    if (referencesRequestInput(node, requestName)) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    if (initializer !== undefined && referencesRequestInput(initializer, requestName)) {
        return true;
    }

    const root = memberAccessRootIdentifier(node);

    if (root !== undefined) {
        const rootInitializer = singleHopInitializer(root);

        return rootInitializer !== undefined && referencesRequestInput(rootInitializer, requestName);
    }

    return false;
};

/**
 * The export name of the nearest *exported* `const x = …` ancestor, or `"<module>"`
 * when the node isn't inside one (e.g. an inline-mounted handler). Walks out past
 * any local `const result = …` bindings to the exported declaration — matching
 * {@link import("./discover-ast").enclosingExportName} — so a sink nested in a
 * local `const` is still attributed to its exported handler, not the local.
 */
export const enclosingExportName = (node: TsNode): string => {
    for (const ancestor of node.getAncestors()) {
        if (Node.isVariableDeclaration(ancestor) && ancestor.getVariableStatement()?.hasExportKeyword() === true) {
            return ancestor.getName();
        }
    }

    return "<module>";
};
