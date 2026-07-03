import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { KvKeyAccessIR } from "./ir";

/**
 * The `ctx.kv` methods whose first argument is a per-entry namespace key. `list`
 * is deliberately excluded — it takes an options object (a `prefix`), not a
 * single key, so it is not an entry-level IDOR sink. Confirmed against the `Kv`
 * facade in `@lunora/bindings/kv`.
 */
const KV_KEY_METHODS = new Set(["delete", "get", "getRaw", "getWithMetadata", "put"]);

/**
 * The `ctx.kv.&lt;method>` key-taking method invoked by `node`, or `undefined` when
 * `node` is not a `ctx.kv` key access. Matched by shape (a property access whose
 * name is a key-taking method and whose receiver text is `ctx.kv`) — the same
 * `import`-agnostic, fail-closed convention the other feeders use, so a re-export
 * or alias still resolves.
 */
const kvKeyMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!KV_KEY_METHODS.has(method)) {
        return undefined;
    }

    const receiver = node.getExpression().getText();

    return receiver === "ctx.kv" || receiver.startsWith("ctx.kv.") ? method : undefined;
};

/** The IR row for a `ctx.kv.&lt;method>(key, …)` call whose key argument is arg-derived and unscoped, or `undefined`. */
const kvAccessInCall = (call: CallExpression, relativePath: string): KvKeyAccessIR | undefined => {
    const method = kvKeyMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const key = call.getArguments()[0];

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a key like `` `${ctx.auth.userId}:${args.id}` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/** Arg-derived, unscoped `ctx.kv` key accesses in one source file. */
const kvAccessesInSourceFile = (sourceFile: SourceFile, relativePath: string): KvKeyAccessIR[] => {
    const found: KvKeyAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const access = kvAccessInCall(call, relativePath);

        if (access) {
            found.push(access);
        }
    }

    return found;
};

/**
 * Discover `ctx.kv.&lt;method>(key, …)` calls in `lunora/` whose key is derived from
 * the handler's `args` with no server-side scoping — the `kv_unscoped_user_key_idor`
 * lint input. Workers KV is a single flat namespace, so a key taken straight from
 * request input lets any caller read, overwrite, or delete another user's entry
 * (IDOR). A fixed literal key, or one prefixed with a server-trusted identity
 * (`` `${ctx.auth.userId}:…` `` — references `ctx`, so treated as scoped), is not
 * recorded; only an arg-derived, unscoped key (directly, or through one local
 * `const` hop) reaches here. `list` is excluded (it takes a prefix, not a key).
 */
const discoverKvKeyAccesses = (project: Project, lunoraDirectory: string): KvKeyAccessIR[] => {
    const accesses: KvKeyAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        accesses.push(...kvAccessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return accesses;
};

export default discoverKvKeyAccesses;
