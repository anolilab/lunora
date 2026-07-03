import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.storage.&lt;bucket>.&lt;method>(key, …)` whose R2 object key is derived
 * from the handler's `args` with no server-side scoping — an object-level IDOR.
 *
 * The bucket read/write/URL/delete methods (`get`, `put`, `delete`, `download`,
 * `store`, `getSignedUrl`, …) take the object key as their first argument. When
 * that key comes straight from request input (`ctx.storage.docs.get(args.key)`, or
 * a key built one hop earlier from `args`), any caller can name any object — reading,
 * overwriting, or deleting another user's file. The fix is to prefix the key with a
 * server-trusted identity (`` `${ctx.auth.userId}/…` ``) or to resolve the object
 * through a record the caller is known to own; a key that references `ctx` is treated
 * as scoped and is not flagged.
 *
 * Runs only when the codegen feeder supplies storage-key evidence
 * (`context.storageKeyAccesses`); a runtime caller flags nothing. One finding per
 * offending call.
 */
const storageKeyFromUserArgs: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.storage.*` call uses an R2 object key taken directly from the handler's `args` with no server-side scoping. The bucket methods key by the caller-supplied string, so any caller can read, overwrite, or delete another user's object — object-level IDOR.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "storage_key_from_user_args",
    remediation: `Prefix the object key with a server-trusted identity (e.g. \`\${ctx.auth.userId}/…\`) or resolve the object through a record the caller is known to own. Never pass request input straight through as an R2 object key.`,
    run: (context) => {
        if (context.storageKeyAccesses === undefined) {
            return [];
        }

        return context.storageKeyAccesses.map((access) =>
            emit(storageKeyFromUserArgs, {
                cacheKey: `storage_key_from_user_args:${access.file}:${access.line.toString()}`,
                detail: `\`ctx.storage.*.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) uses an object key derived from \`args\` with no server-side scoping — any caller can read/overwrite/delete another user's object (IDOR). Prefix the key with a server-trusted identity (e.g. \`\${ctx.auth.userId}/…\`) or resolve the object through an owned record.`,
                metadata: { exportName: access.exportName, file: access.file, line: access.line, method: access.method },
            }),
        );
    },
    source: "static",
    title: "R2 object key taken directly from user args (IDOR)",
};

export default storageKeyFromUserArgs;
