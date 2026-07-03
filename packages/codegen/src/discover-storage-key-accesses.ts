import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { StorageKeyAccessIR } from "./ir";

/**
 * The `ctx.storage.&lt;bucket>.&lt;method>(...)` bucket methods whose first argument is a
 * per-object R2 key — the IDOR sinks. Confirmed against `@lunora/storage`'s
 * `Storage` surface (the read/write/URL/multipart methods that take `key` as
 * arg[0]), plus the raw R2 verbs (`get`/`put`/`head`) a re-export may surface.
 * `list` (a key *prefix*) and `bucket` (a bucket selector) are excluded — neither
 * takes a per-object key, so an `args`-derived argument there is not object-level
 * IDOR.
 */
const KEY_TAKING_METHODS = new Set<string>([
    "createMultipartUpload",
    "delete",
    "download",
    "generateUploadUrl",
    "get",
    "getMetadata",
    "getPresignedUrl",
    "getSignedUrl",
    "getUrl",
    "head",
    "put",
    "resumeMultipartUpload",
    "store",
    "upload",
]);

/**
 * The key-taking bucket method name when `node` is a `ctx.storage.&lt;bucket>.&lt;method>`
 * member access, else `undefined`. Matched by shape — a {@link KEY_TAKING_METHODS}
 * property whose receiver is the default bucket (`ctx.storage`) or a named bucket
 * (`ctx.storage.&lt;bucket>` / `ctx.storage.bucket("…")`, i.e. text starting with
 * `ctx.storage.`) — the same `import`-agnostic, fail-closed convention the other
 * feeders use, so a re-export or alias still resolves. The method allowlist gate
 * keeps the non-key `ctx.storage.bucket("…")` selector and `ctx.storage.list(…)`
 * out even though their receiver matches.
 */
const storageKeyMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!KEY_TAKING_METHODS.has(method)) {
        return undefined;
    }

    const receiver = node.getExpression().getText();

    return receiver === "ctx.storage" || receiver.startsWith("ctx.storage.") ? method : undefined;
};

/** The IR row for a `ctx.storage.&lt;bucket>.&lt;method>(key, …)` call whose key is arg-derived and unscoped, or `undefined`. */
const storageKeyInCall = (call: CallExpression, relativePath: string): StorageKeyAccessIR | undefined => {
    const method = storageKeyMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const key = call.getArguments()[0];

    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/** Arg-derived, unscoped `ctx.storage.&lt;bucket>` object keys in one source file. */
const storageKeyAccessesInSourceFile = (sourceFile: SourceFile, relativePath: string): StorageKeyAccessIR[] => {
    const found: StorageKeyAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const access = storageKeyInCall(call, relativePath);

        if (access) {
            found.push(access);
        }
    }

    return found;
};

/**
 * Discover `ctx.storage.&lt;bucket>.&lt;method>(key, …)` calls in `lunora/` whose object
 * key is derived from the handler's `args` with no server-side scoping — the
 * `storage_key_from_user_args` lint input. An R2 key taken straight from request
 * input lets any caller read, overwrite, or delete another user's object
 * (object-level IDOR). A key prefixed with a server-trusted identity (a `ctx.*`
 * value such as `` `${ctx.auth.userId}/…` ``) is treated as scoped and is *not*
 * recorded; only an arg-derived key (directly, or through one local `const` hop)
 * that references no `ctx` reaches here. `list`/`bucket` are excluded — they take
 * no per-object key.
 */
const discoverStorageKeyAccesses = (project: Project, lunoraDirectory: string): StorageKeyAccessIR[] => {
    const accesses: StorageKeyAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        accesses.push(...storageKeyAccessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return accesses;
};

export default discoverStorageKeyAccesses;
