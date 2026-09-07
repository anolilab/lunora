import emit from "../../finding";
import type { Lint } from "../../types";

/* eslint-disable no-secrets/no-secrets -- this file repeatedly quotes the `WorkerOptions` field name `allowUnauthenticatedShardAccess`, not a credential */

/**
 * The two callees that can carry the opt-in: the `@lunora/vite` plugin factory
 * (`vite.config.*`, the class-A path) and the generated `defineApp()` builder's
 * `.extend(...)` escape hatch (a worker entry, the class-B path).
 */
const OPT_IN_CALLEES: ReadonlySet<string> = new Set(["extend", "lunora"]);

/**
 * Flags an app that opts into `allowUnauthenticatedShardAccess: true` while its
 * schema has an RLS gap (no `.rls("required")`, or a `.public()` table).
 *
 * `allowUnauthenticatedShardAccess` (a `WorkerOptions` field consumed by
 * `createWorker(...)`) turns off the fail-closed default that denies a shard
 * lookup for a request with no verified identity. That is a deliberate, opt-in
 * posture switch — appropriate for a public/anonymous-first shard resolver — but
 * combined with a schema that never enforces `.rls("required")` (or that leaves
 * a table `.public()`, i.e. exempt from it), an unauthenticated caller can shard-hop
 * and read another tenant's rows with no row-security guard behind the door.
 *
 * **Evidence**: this reads `context.configCalls`, fed by the codegen
 * `discover/config-calls.ts` feeder, and covers BOTH places the field can be
 * set. `lunora({ allowUnauthenticatedShardAccess: true })` in `vite.config.*`
 * is the documented opt-in for the auto-composed class-A worker, and is the
 * only place a class-A app (the default Vite path — `sveltekit` / `astro` /
 * `react-router` / `tanstack-start`) can set it at all, since it has no worker
 * entry. `defineApp()...extend(() => ({ allowUnauthenticatedShardAccess: true }))`
 * is the class-B escape hatch (the `nuxt` / `analog` templates' `lunora/server.ts`),
 * read from `lunora/` and the worker entry alike.
 *
 * Still out of view: a hand-written entry passing the field straight to
 * `createWorker({...})` — that callee is not one the feeder reads.
 *
 * Runs only when the codegen feeder supplies config-call evidence; a runtime
 * caller flags nothing. One finding per opted-in call site.
 */
const allowUnauthenticatedShardAccessEnabled: Lint = {
    categories: ["SECURITY"],
    description:
        "`allowUnauthenticatedShardAccess: true` — set on the `lunora()` Vite plugin, or through `.extend(() => ({ … }))` — disables the fail-closed default that denies an unauthenticated shard lookup. Combined with a schema that doesn't enforce `.rls(\"required\")` everywhere (or that leaves a table `.public()`), an unauthenticated caller can shard-hop into another tenant's rows with no row-security guard behind the door.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "allow_unauthenticated_shard_access_enabled",
    remediation:
        "Prefer `authorizeShard` / `authorizeFanOut` (which take precedence over `allowUnauthenticatedShardAccess` and let you allow specific unauthenticated cases) over the blanket opt-out. If the app genuinely needs open shard access, enforce `.rls(\"required\")` on the schema with no `.public()` tables so a missing identity still can't read another tenant's rows.",
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        const hasRlsGap = context.schema.rlsMode !== "required" || context.schema.tables.some((table) => table.isPublic);

        if (!hasRlsGap) {
            return [];
        }

        return context.configCalls
            .filter((call) => OPT_IN_CALLEES.has(call.callee) && call.trueKeys.includes("allowUnauthenticatedShardAccess"))
            .map((call) =>
                emit(allowUnauthenticatedShardAccessEnabled, {
                    cacheKey: `allow_unauthenticated_shard_access_enabled:${call.file}:${call.line.toString()}`,
                    detail: `\`${call.callee === "lunora" ? "lunora(...)" : ".extend(...)"}\` in ${call.file}:${call.line.toString()} sets \`allowUnauthenticatedShardAccess: true\`, and the schema has an RLS gap (no \`.rls("required")\`, or a \`.public()\` table) — an unauthenticated caller can shard-hop into another tenant's rows with no row-security guard behind the door.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "Unauthenticated shard access enabled on an RLS-gapped schema",
};

export default allowUnauthenticatedShardAccessEnabled;
