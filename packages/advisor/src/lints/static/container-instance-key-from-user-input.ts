import type { AdvisorContainerKeyAccess } from "../../container-key-accesses";
import type { Lint } from "../../types";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";

/**
 * Flags a `ctx.containers.<exportName>.get(name, …)` call whose instance key
 * is derived from the handler's `args` with no server-side scoping — a
 * cross-tenant container IDOR.
 *
 * A container definition's `.get(name)` accessor routes to one Durable
 * Object-backed container instance per `name` — one container per entity
 * (user, room, job…). When the key comes straight from request input
 * (`ctx.containers.app.get(args.id)`, a template embedding `args.*`, or a key
 * built one hop earlier from `args`), any caller can hand in another tenant's
 * key and reach that tenant's container instance. The fix is to derive the
 * key from a server-trusted identity (`` `${ctx.auth.userId}` ``) or a record
 * the caller owns — a key that references `ctx` is treated as scoped and is
 * not flagged. `.any()`/`.pool()` are not sinks (they take no key).
 *
 * Runs only when the codegen feeder supplies container key-access evidence
 * (`context.containerKeyAccesses`); a runtime caller flags nothing. One
 * finding per arg-derived, unscoped `ctx.containers.*.get` call.
 */
const containerInstanceKeyFromUserInput: Lint = makeArgumentDerivedSinkLint<AdvisorContainerKeyAccess>({
    cacheKey: (access) => `container_instance_key_from_user_input:${access.file}:${access.line.toString()}`,
    categories: ["SECURITY"],
    description:
        "A `ctx.containers.<name>.get` call routes to a container instance using a key derived from the handler's `args` with no server-side scoping. Any caller can supply another tenant's key and reach that tenant's container instance — a cross-tenant insecure direct object reference (IDOR).",
    detail: (access) =>
        `\`ctx.containers.*.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) routes to a container instance using a key derived from \`args\` with no server-side scoping — any caller can reach another tenant's container (IDOR). Derive the key from a server-trusted identity (e.g. \`\${ctx.auth.userId}\`).`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.containerKeyAccesses,
    level: "WARN",
    metadata: (access) => {
        return { exportName: access.exportName, file: access.file, line: access.line, method: access.method };
    },
    name: "container_instance_key_from_user_input",
    remediation: `Derive the container instance key from a server-trusted identity (e.g. \`\${ctx.auth.userId}\`) or a record the caller owns — never pass request input straight to \`ctx.containers.<name>.get\`.`,
    title: "Possible cross-tenant IDOR from arg-derived unscoped container key",
});

export default containerInstanceKeyFromUserInput;
