import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext, singleHopInitializer } from "../argument-taint";
import type { VectorNamespaceAccessIR } from "../ir";
import { collectCallRows, propertyInitializer } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { isContextSurface } from "./context-root";

/**
 * The `ctx.vectors` methods whose second argument may carry a `namespace`
 * field — confirmed against the facade `createContextVectors` builds in
 * `@lunora/bindings/vectors`, which is what `ctx.vectors` is. `query`,
 * `upsert` and `upsertNow` each take a single `{ namespace, … }` input object;
 * `upsertMany` takes an array of them.
 */
const VECTOR_NAMESPACE_METHODS = new Set(["query", "upsert", "upsertMany", "upsertNow"]);

/**
 * The `ctx.vectors.<method>` namespace-taking method invoked by `node`, or
 * `undefined` when `node` is not a `ctx.vectors` call. Matched by shape (a
 * property access whose name is a namespace-taking method and whose receiver
 * text is exactly `ctx.vectors`) — the same `import`-agnostic, fail-closed
 * convention the other feeders use, so a re-export or alias still resolves.
 */
const vectorsNamespaceMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!VECTOR_NAMESPACE_METHODS.has(method)) {
        return undefined;
    }

    return isContextSurface(node.getExpression(), ["vectors"]) ? method : undefined;
};

/** The `namespace` of one record: an explicit initializer or a shorthand `{ namespace }` (the identifier, which the taint check resolves). */
const recordNamespace = (element: TsNode): TsNode | undefined => {
    // An identifier element (`[record]`) resolves one local hop to its initializer.
    const record = Node.isIdentifier(element) ? singleHopInitializer(element) : element;

    if (!record || !Node.isObjectLiteralExpression(record)) {
        return undefined;
    }

    const shorthand = record.getProperty("namespace");

    return Node.isShorthandPropertyAssignment(shorthand) ? shorthand.getNameNode() : propertyInitializer(record, "namespace");
};

/** The object literals a `.map` callback returns: an arrow expression body, or the `return`s of its own block body. */
const mapCallbackRecords = (callback: TsNode | undefined): TsNode[] => {
    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return [];
    }

    const body = callback.getBody();

    if (!Node.isBlock(body)) {
        return [Node.isParenthesizedExpression(body) ? body.getExpression() : body];
    }

    return body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) === callback)
        .flatMap((statement) => statement.getExpression() ?? []);
};

/** A record's `namespace` node, plus whether it reads a `.map` callback parameter whose source array is argument-derived. */
interface NamespaceCandidate {
    namespace: TsNode | undefined;
    viaParameter?: boolean;
}

/** The names a `.map` callback's first parameter binds: the parameter itself, or each element of a destructuring pattern. */
const callbackParameterNames = (callback: TsNode | undefined): string[] => {
    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return [];
    }

    const name = callback.getParameters()[0]?.getNameNode();

    if (!name) {
        return [];
    }

    return Node.isIdentifier(name) ? [name.getText()] : name.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getName());
};

/** An identifier bound by a `const` inside the `.map` callback resolves one hop to its initializer; any other node is returned unchanged. */
const callbackLocalInitializer = (callback: TsNode | undefined, node: TsNode | undefined): TsNode | undefined => {
    if (!callback || !node || !Node.isIdentifier(node)) {
        return node;
    }

    const declaration = callback
        .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((variable) => variable.getName() === node.getText() && variable.getInitializer() !== undefined);

    return declaration?.getInitializer() ?? node;
};

/** Whether `node` is, or contains, an identifier spelled as one of `names`. */
const referencesAnyName = (node: TsNode, names: string[]): boolean =>
    names.length > 0 &&
    [node, ...node.getDescendantsOfKind(SyntaxKind.Identifier)].some((candidate) => Node.isIdentifier(candidate) && names.includes(candidate.getText()));

/**
 * The `namespace` nodes of the records an `upsertMany` second argument holds,
 * traced statically: an array literal (spread elements followed), a `.map(...)`
 * call (the callback's returned objects), or an identifier bound by ONE local
 * `const` hop to either. Anything else yields nothing — fail open, as the
 * single-record methods do for a non-literal input.
 */
const recordNamespaces = (input: TsNode, canHop = true): NamespaceCandidate[] => {
    if (Node.isIdentifier(input)) {
        const initializer = canHop ? singleHopInitializer(input) : undefined;

        return initializer ? recordNamespaces(initializer, false) : [];
    }

    if (Node.isArrayLiteralExpression(input)) {
        return input
            .getElements()
            .flatMap((element) =>
                Node.isSpreadElement(element) ? recordNamespaces(element.getExpression(), canHop) : [{ namespace: recordNamespace(element) }],
            );
    }

    const callee = Node.isCallExpression(input) ? input.getExpression() : undefined;

    if (Node.isCallExpression(input) && Node.isPropertyAccessExpression(callee) && callee.getName() === "map") {
        const callback = input.getArguments()[0];

        // A callback parameter is as tainted as the array it iterates over.
        const names = isArgumentDerived(callee.getExpression()) ? callbackParameterNames(callback) : [];

        return mapCallbackRecords(callback).map((record) => {
            const namespace = callbackLocalInitializer(callback, recordNamespace(record));

            return { namespace, viaParameter: namespace !== undefined && referencesAnyName(namespace, names) };
        });
    }

    return [];
};

/** The IR row for a `ctx.vectors.<method>(indexName, input)` call whose `input.namespace` is arg-derived and unscoped, or `undefined`. */
const vectorNamespaceAccessInCall = (call: CallExpression, relativePath: string): VectorNamespaceAccessIR | undefined => {
    const method = vectorsNamespaceMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const input = call.getArguments()[1];

    if (!input) {
        return undefined;
    }

    // `upsertMany` takes an array literal: every element's namespace is checked.
    const namespaces = method === "upsertMany" ? recordNamespaces(input) : [{ namespace: propertyInitializer(input, "namespace") }];

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a namespace like `` `${ctx.auth.orgId}` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (
        !namespaces.some(({ namespace, viaParameter }) => namespace && (viaParameter === true || isArgumentDerived(namespace)) && !isScopedByContext(namespace))
    ) {
        return undefined;
    }

    return { scope: callSiteScopeOf(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/**
 * Discover `ctx.vectors.<method>(indexName, input)` calls in `lunora/` whose
 * `input.namespace` is derived from the handler's `args` with no server-side
 * scoping — the `vectors_namespace_from_user_input` lint input. A Vectorize
 * namespace partitions one index into isolated sub-collections, so a namespace
 * taken straight from request input lets any caller read or poison another
 * tenant's vectors. A fixed literal namespace, one prefixed with a
 * server-trusted identity (`` `${ctx.auth.orgId}` `` — references `ctx`, so
 * treated as scoped), or a call whose argument isn't a direct object literal
 * with a `namespace` property, is not recorded; only an arg-derived, unscoped
 * `namespace` (directly, or through one local `const` hop) reaches here.
 */
const discoverVectorNamespaceAccesses = (project: Project, lunoraDirectory: string): VectorNamespaceAccessIR[] =>
    collectCallRows(project, lunoraDirectory, vectorNamespaceAccessInCall);

export default discoverVectorNamespaceAccesses;
