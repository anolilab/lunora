import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { collectCallRows, propertyInitializer } from "./discover-ast";
import type { VectorNamespaceAccessIR } from "./ir";

/**
 * The `ctx.vectors` methods whose second argument may carry a `namespace`
 * field — confirmed against the `LunoraVectors` facade in
 * `@lunora/bindings/vectors`. `query` and `upsert` take a single
 * `{ namespace, … }` input object; `upsertMany` takes an *array* of such
 * objects, so its typical call shape does not satisfy the direct
 * object-literal check below and produces no evidence today. It is kept in
 * the sink set (rather than excluded) for shape completeness and so a future
 * per-element check can extend it without touching the sink list again.
 */
const VECTOR_NAMESPACE_METHODS = new Set(["query", "upsert", "upsertMany"]);

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

    return node.getExpression().getText() === "ctx.vectors" ? method : undefined;
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

    const namespace = propertyInitializer(input, "namespace");

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a namespace like `` `${ctx.auth.orgId}` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!namespace || !isArgumentDerived(namespace) || isScopedByContext(namespace)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
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
