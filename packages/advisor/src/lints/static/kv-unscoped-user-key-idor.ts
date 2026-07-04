import type { AdvisorKvKeyAccess } from "../../kv-key-accesses";
import type { Lint } from "../../types";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";

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
const kvUnscopedUserKeyIdor: Lint = makeArgumentDerivedSinkLint<AdvisorKvKeyAccess>({
    cacheKey: (access) => `kv_unscoped_user_key_idor:${access.file}:${access.line.toString()}`,
    categories: ["SECURITY"],
    description:
        "A `ctx.kv` read/write uses a namespace key derived from the handler's `args` with no server-side scoping. Workers KV is a flat namespace, so an unscoped key lets any caller read, overwrite, or delete another user's entry — an insecure direct object reference (IDOR).",
    detail: (access) =>
        `\`ctx.kv.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) uses a KV key derived from \`args\` with no server-side scoping — any caller can read/overwrite/delete another user's entry (IDOR). Prefix the key with a server-trusted identity (e.g. \`\${ctx.auth.userId}:…\`).`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.kvKeyAccesses,
    level: "ERROR",
    metadata: (access) => {
        return { exportName: access.exportName, file: access.file, line: access.line, method: access.method };
    },
    name: "kv_unscoped_user_key_idor",
    remediation: `Prefix every \`ctx.kv\` key with a server-trusted identity (e.g. \`\${ctx.auth.userId}:\${args.id}\`) so a caller can only address their own entries. Never pass request input straight to \`ctx.kv.get\`/\`put\`/\`delete\`.`,
    title: "Possible IDOR from arg-derived unscoped KV key",
});

export default kvUnscopedUserKeyIdor;
