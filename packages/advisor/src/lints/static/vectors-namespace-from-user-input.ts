import type { Lint } from "../../types";
import type { AdvisorVectorNamespaceAccess } from "../../vector-namespace-accesses";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";

/**
 * Flags a `ctx.vectors.query`/`upsert`/`upsertMany` call whose `namespace`
 * input is derived from the handler's `args` with no server-side scoping — a
 * tenant-partition escape.
 *
 * Vectorize namespaces partition a single index into isolated sub-collections
 * (typically one per tenant/user). When a namespace comes straight from
 * request input (`ctx.vectors.query(idx, { namespace: args.tenant })`, or a
 * value built one hop earlier from `args`), any caller can hand in another
 * tenant's namespace and read or poison that tenant's vectors. The fix is to
 * derive the namespace from a server-trusted identity (`` `${ctx.auth.orgId}` ``)
 * so a caller can only ever address their own partition — a namespace that
 * references `ctx` is treated as scoped and is not flagged.
 *
 * Runs only when the codegen feeder supplies vector-namespace evidence
 * (`context.vectorNamespaceAccesses`); a runtime caller flags nothing. One
 * finding per arg-derived, unscoped `ctx.vectors` call.
 */
const vectorsNamespaceFromUserInput: Lint = makeArgumentDerivedSinkLint<AdvisorVectorNamespaceAccess>({
    cacheKey: (access) => `vectors_namespace_from_user_input:${access.file}:${access.line.toString()}`,
    categories: ["SECURITY"],
    description:
        "A `ctx.vectors.query`/`upsert`/`upsertMany` call uses a `namespace` derived from the handler's `args` with no server-side scoping. A Vectorize namespace partitions one index into isolated sub-collections, so an unscoped namespace lets any caller read or poison another tenant's vectors.",
    detail: (access) =>
        `\`ctx.vectors.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) uses a Vectorize namespace derived from \`args\` with no server-side scoping — any caller can read or poison another tenant's vectors. Derive the namespace from a server-trusted identity (e.g. \`\${ctx.auth.orgId}\`), never from \`args\`.`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.vectorNamespaceAccesses,
    level: "WARN",
    metadata: (access) => {
        return { exportName: access.exportName, file: access.file, line: access.line, method: access.method };
    },
    name: "vectors_namespace_from_user_input",
    remediation: `Derive the \`namespace\` from a server-trusted identity (e.g. \`\${ctx.auth.orgId}\`), never from \`args\`.`,
    title: "Vectorize namespace derived from unscoped user input",
});

export default vectorsNamespaceFromUserInput;
