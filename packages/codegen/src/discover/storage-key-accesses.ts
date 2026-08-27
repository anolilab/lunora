import type { Project } from "ts-morph";

import { discoverArgumentDerivedAccesses } from "./discover-argument-derived-accesses";
import type { FunctionIR, StorageKeyAccessIR } from "./ir";

/**
 * The `ctx.storage.<bucket>.<method>(...)` bucket methods whose first argument is a
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
 * Discover `ctx.storage.<bucket>.<method>(key, …)` calls in `lunora/` whose object
 * key is derived from the handler's `args` with no server-side scoping — the
 * `storage_key_from_user_args` lint input. An R2 key taken straight from request
 * input lets any caller read, overwrite, or delete another user's object
 * (object-level IDOR). A key prefixed with a server-trusted identity (a `ctx.*`
 * value such as `` `${ctx.auth.userId}/…` ``) is treated as scoped and is *not*
 * recorded; only an arg-derived key (directly, or through one local `const` hop)
 * that references no `ctx` reaches here. `list`/`bucket` are excluded — they take
 * no per-object key.
 *
 * Two narrowings on top of the shared taint walk, both closing false positives
 * reported against real `internalAction`s receiving a content-addressed storage
 * id minted server-side (issue #284):
 *
 * - `requireUnmodifiedReach: true` — a key rebuilt by an intervening call (a
 * `storeFile(...)` helper returning a SHA-256 of the bytes) is not
 * caller-controlled input reaching the sink verbatim, so it is not recorded.
 * See `isUnmodifiedArgumentPassthrough`.
 * - `functions` (optional; defaults to `[]`, matching `discoverOwnerFieldWrites`)
 * attaches each access's enclosing procedure's `visibility` — `internal`
 * procedures have no untrusted caller by construction, so the lint drops them
 * to INFO instead of ERROR rather than dropping them entirely: a PUBLIC
 * procedure that forwards raw `args` into one is still the real vector.
 */
const discoverStorageKeyAccesses = (project: Project, lunoraDirectory: string, functions: ReadonlyArray<FunctionIR> = []): StorageKeyAccessIR[] => {
    // Keyed on file + export because two modules may export the same name.
    const visibilityByKey = new Map(functions.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.visibility]));

    const accesses = discoverArgumentDerivedAccesses(project, lunoraDirectory, {
        argIndex: 0,
        matchReceiver: (receiver) => receiver === "ctx.storage" || receiver.startsWith("ctx.storage."),
        methods: KEY_TAKING_METHODS,
        requireUnmodifiedReach: true,
    });

    return accesses.map((access) => {
        const visibility = visibilityByKey.get(`${access.file}:${access.exportName}`);

        return visibility === undefined ? access : { ...access, visibility };
    });
};

export default discoverStorageKeyAccesses;
