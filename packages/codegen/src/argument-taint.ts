import type { BindingElement, Identifier, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/**
 * The parameter binding element that declares `name`, searched from the
 * innermost enclosing function outward so a shadowing parameter wins over an
 * outer one. Only PARAMETER patterns are searched: `({ args: { url } })` is the
 * house style every handler is written in, and a parameter cannot be
 * reassigned out from under the use the way a later `const` can, so this needs
 * none of {@link singleHopInitializer}'s scope-order care.
 */
const parameterBindingFor = (identifier: Identifier): BindingElement | undefined => {
    const name = identifier.getText();
    const declares = (candidate: BindingElement): boolean => {
        const nameNode = candidate.getNameNode();

        return Node.isIdentifier(nameNode) && nameNode.getText() === name;
    };

    for (const ancestor of identifier.getAncestors()) {
        if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor) && !Node.isFunctionDeclaration(ancestor)) {
            continue;
        }

        for (const parameter of ancestor.getParameters()) {
            const element = parameter.getDescendantsOfKind(SyntaxKind.BindingElement).find((candidate) => declares(candidate));

            if (element !== undefined) {
                return element;
            }
        }
    }

    return undefined;
};

/**
 * The property name the outermost element of `element`'s destructuring chain
 * reads off the parameter object — `({ args: { url: target } })`'s `target`
 * resolves to `"args"`, and so does the `...rest` of `({ args: { url,
 * ...rest } })`, because a rest element holds what is left of the same object.
 * `undefined` when the chain is not rooted directly in a parameter's pattern
 * (an array pattern, or a nested function's own binding).
 */
const destructuringRootName = (element: BindingElement): string | undefined => {
    let outermost = element;

    for (;;) {
        const pattern = outermost.getParent();

        if (!Node.isObjectBindingPattern(pattern)) {
            return undefined;
        }

        const owner = pattern.getParent();

        if (Node.isBindingElement(owner)) {
            outermost = owner;

            continue;
        }

        if (!Node.isParameterDeclaration(owner)) {
            return undefined;
        }

        // The renamed spelling reads `propertyName`; a shorthand (and a rest
        // element) reads its own name.
        return (outermost.getPropertyNameNode() ?? outermost.getNameNode()).getText();
    }
};

/**
 * True when `identifier` is a *value* reference to the binding named `name` —
 * the taint-root check shared by every Wave 3 feeder, whether the root is the
 * fixed `args`/`ctx` binding or an `httpAction` handler's freely-named request
 * parameter (`request` / `req` / `r`). Excludes the trailing `.<name>` of a
 * member access and the key of an explicit `{ <name>: … }` property, which name
 * a different `<name>` and carry no taint; a `{ <name> }` shorthand IS a value
 * reference and is kept.
 *
 * A handler that destructures its parameter — `({ args: { url }, ctx }) => …
 * url` — binds `url` to a field OF `args`, so `url` is a value reference to
 * `args` just as `args.url` is. Renaming (`{ args: { url: target } }`),
 * nesting, and rest elements all resolve through the same chain walk. Without
 * this the destructured spelling (the one every registry item, example and doc
 * snippet is written in) carried no taint at all, so three ERROR/WARN sink
 * lints could not fire on the code this repo itself ships.
 */
const isValueReference = (identifier: Identifier, name: string): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (identifier.getText() === name) {
        return true;
    }

    const element = parameterBindingFor(identifier);

    return element !== undefined && destructuringRootName(element) === name;
};

/** True when `node` is, or textually contains, a value reference to the binding named `name`. */
const referencesBinding = (node: TsNode, name: string): boolean => {
    if (Node.isIdentifier(node)) {
        return isValueReference(node, name);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isValueReference(identifier, name));
};

/** True when `node` is, or textually contains, a value reference to the `ctx` binding. */
const textuallyReferencesContext = (node: TsNode): boolean => referencesBinding(node, "ctx");

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

/** True when `node` is, or textually contains, a value reference to the `args` binding. */
export const referencesArgs = (node: TsNode): boolean => referencesBinding(node, "args");

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
export const referencesRequestInput = (node: TsNode, requestName: string): boolean => referencesBinding(node, requestName);

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
 * {@link import("./discover/ast").enclosingExportName} — so a sink nested in a
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
