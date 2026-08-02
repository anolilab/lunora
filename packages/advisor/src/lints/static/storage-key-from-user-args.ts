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

        return context.storageKeyAccesses.map((access) => {
            const where = `\`ctx.storage.*.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()})`;
            const metadata = {
                exportName: access.exportName,
                file: access.file,
                line: access.line,
                method: access.method,
                visibility: access.visibility ?? "unknown",
            };

            // An `internal*` procedure has no untrusted caller by construction —
            // it is only reachable server-side (`ctx.scheduler.runAfter`,
            // `ctx.run*`), never by an external request — so "any caller can
            // read/overwrite/delete another user's object" is false there.
            // Mirrors `owner_field_from_args_not_auth`'s identical visibility
            // split: two real-world hits were both `internalAction`s receiving
            // a content-addressed storage id minted server-side (issue #284).
            if (access.visibility === "internal") {
                return emit(storageKeyFromUserArgs, {
                    cacheKey: `storage_key_from_user_args:${access.file}:${access.line.toString()}`,
                    detail: `${where} uses an object key derived from \`args\` with no server-side scoping. This is expected for an \`internal\` procedure — no caller can reach it directly, so the key is only ever supplied by trusted server code. Audit the PUBLIC procedures that dispatch to it: if one forwards \`args\` straight through, the IDOR is there.`,
                    facing: "INTERNAL",
                    level: "INFO",
                    metadata,
                });
            }

            return emit(storageKeyFromUserArgs, {
                cacheKey: `storage_key_from_user_args:${access.file}:${access.line.toString()}`,
                detail: `${where} uses an object key derived from \`args\` with no server-side scoping — any caller can read/overwrite/delete another user's object (IDOR). Prefix the key with a server-trusted identity (e.g. \`\${ctx.auth.userId}/…\`) or resolve the object through an owned record.`,
                metadata,
            });
        });
    },
    source: "static",
    title: "R2 object key taken directly from user args (IDOR)",
};

export default storageKeyFromUserArgs;
