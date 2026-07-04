import type { Project } from "ts-morph";

import { discoverArgumentDerivedAccesses } from "./discover-argument-derived-accesses";
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
const discoverStorageKeyAccesses = (project: Project, lunoraDirectory: string): StorageKeyAccessIR[] =>
    discoverArgumentDerivedAccesses(project, lunoraDirectory, {
        argIndex: 0,
        matchReceiver: (receiver) => receiver === "ctx.storage" || receiver.startsWith("ctx.storage."),
        methods: KEY_TAKING_METHODS,
    });

export default discoverStorageKeyAccesses;
