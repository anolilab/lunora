import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.kv` read/write whose namespace key is derived from the handler's
 * `args` with no server-side scoping — a namespace-level insecure direct object
 * reference (IDOR).
 *
 * Workers KV is a single flat namespace with no per-caller isolation. When a key
 * comes straight from request input (`ctx.kv.get(args.key)`, a template embedding
 * `args.*`, or a key built one hop earlier from `args`), any caller can hand in
 * another user's key and read, overwrite, or delete that user's entry. The fix is
 * to prefix every key with a server-trusted identity (`` `${ctx.auth.userId}:…` ``)
 * so a caller can only ever address their own entries — a key that references
 * `ctx` is treated as scoped and is not flagged. `list` is not a sink (it takes a
 * prefix, not a per-entry key).
 *
 * Runs only when the codegen feeder supplies KV key-access evidence
 * (`context.kvKeyAccesses`); a runtime caller flags nothing. One finding per
 * arg-derived, unscoped `ctx.kv` call.
 */
const kvUnscopedUserKeyIdor: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.kv` read/write uses a namespace key derived from the handler's `args` with no server-side scoping. Workers KV is a flat namespace, so an unscoped key lets any caller read, overwrite, or delete another user's entry — an insecure direct object reference (IDOR).",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "kv_unscoped_user_key_idor",
    remediation: `Prefix every \`ctx.kv\` key with a server-trusted identity (e.g. \`\${ctx.auth.userId}:\${args.id}\`) so a caller can only address their own entries. Never pass request input straight to \`ctx.kv.get\`/\`put\`/\`delete\`.`,
    run: (context) => {
        if (context.kvKeyAccesses === undefined) {
            return [];
        }

        return context.kvKeyAccesses.map((access) => {
            const where = `\`ctx.kv.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()})`;
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
            // read/overwrite/delete another user's entry" is false there. The
            // third arg-derived sink to get this split, after
            // `owner_field_from_args_not_auth` and `storage_key_from_user_args`,
            // where every real-world hit was an `internal*` procedure handed a
            // key minted server-side. ERROR is the build-failing tier, so a
            // false one there aborts `lunora codegen` / `lunora deploy`.
            if (access.visibility === "internal") {
                return emit(kvUnscopedUserKeyIdor, {
                    cacheKey: `kv_unscoped_user_key_idor:${access.file}:${access.line.toString()}`,
                    detail: `${where} uses a KV key derived from \`args\` with no server-side scoping. This is expected for an \`internal\` procedure — no caller can reach it directly, so the key is only ever supplied by trusted server code. Audit the PUBLIC procedures that dispatch to it: if one forwards \`args\` straight through, the IDOR is there.`,
                    facing: "INTERNAL",
                    level: "INFO",
                    metadata,
                });
            }

            return emit(kvUnscopedUserKeyIdor, {
                cacheKey: `kv_unscoped_user_key_idor:${access.file}:${access.line.toString()}`,
                detail: `${where} uses a KV key derived from \`args\` with no server-side scoping — any caller can read/overwrite/delete another user's entry (IDOR). Prefix the key with a server-trusted identity (e.g. \`\${ctx.auth.userId}:…\`).`,
                metadata,
            });
        });
    },
    source: "static",
    title: "Possible IDOR from arg-derived unscoped KV key",
};

export default kvUnscopedUserKeyIdor;
