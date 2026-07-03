import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ContainerKeyAccessIR } from "./ir";

/** The `ctx.containers.` accessor prefix a single-container instance sink must start with. */
const CONTAINER_ACCESSOR_PREFIX = "ctx.containers.";

/**
 * `"get"` when `node` is the callee of a `ctx.containers.&lt;exportName>.get(name, …)`
 * call — a property access named `get` whose receiver is a *single* container
 * accessor (`ctx.containers.&lt;exportName>`, with nothing past the export segment) —
 * or `undefined` otherwise. Matched by shape (property-access name + receiver
 * text), the same `import`-agnostic, fail-closed convention the other feeders
 * use, so a re-export or alias still resolves. `.any()`/`.pool()` take no key
 * and carry a different method name, so they never match here.
 */
const containerGetMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (method !== "get") {
        return undefined;
    }

    const receiver = node.getExpression().getText();

    if (!receiver.startsWith(CONTAINER_ACCESSOR_PREFIX)) {
        return undefined;
    }

    const remainder = receiver.slice(CONTAINER_ACCESSOR_PREFIX.length);

    return remainder.length > 0 && !remainder.includes(".") ? method : undefined;
};

/** The IR row for a `ctx.containers.&lt;exportName>.get(name, …)` call whose key argument is arg-derived and unscoped, or `undefined`. */
const containerAccessInCall = (call: CallExpression, relativePath: string): ContainerKeyAccessIR | undefined => {
    const method = containerGetMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const key = call.getArguments()[0];

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a key like `` `${ctx.auth.userId}` `` is
    // treated as scoped and is not flagged.
    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/** Arg-derived, unscoped `ctx.containers.*.get` key accesses in one source file. */
const containerAccessesInSourceFile = (sourceFile: SourceFile, relativePath: string): ContainerKeyAccessIR[] => {
    const found: ContainerKeyAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const access = containerAccessInCall(call, relativePath);

        if (access) {
            found.push(access);
        }
    }

    return found;
};

/**
 * Discover `ctx.containers.&lt;exportName>.get(name, …)` calls in `lunora/` whose
 * instance key is derived from the handler's `args` with no server-side
 * scoping — the `container_instance_key_from_user_input` lint input. Each
 * container definition's `.get(name)` accessor routes to one instance per
 * `name`, so a key taken straight from request input lets any caller reach any
 * other tenant's container (a cross-tenant IDOR). A fixed literal key, or one
 * derived from a server-trusted identity (`` `${ctx.auth.userId}` `` —
 * references `ctx`, so treated as scoped), is not recorded; only an
 * arg-derived, unscoped key (directly, or through one local `const` hop)
 * reaches here. `.any()`/`.pool()` take no key and are not sinks.
 */
const discoverContainerKeyAccesses = (project: Project, lunoraDirectory: string): ContainerKeyAccessIR[] => {
    const accesses: ContainerKeyAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        accesses.push(...containerAccessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return accesses;
};

export default discoverContainerKeyAccesses;
