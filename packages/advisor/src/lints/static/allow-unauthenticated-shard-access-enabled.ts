import emit from "../../finding";
import type { Lint } from "../../types";

/* eslint-disable no-secrets/no-secrets -- this file repeatedly quotes the `WorkerOptions` field name `allowUnauthenticatedShardAccess`, not a credential */

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
 * **Evidence and coverage gap**: this reads `context.configCalls`, fed by the
 * codegen `discover-config-calls.ts` feeder's `.extend(fn)` callback-shape
 * support — it only sees the setting when a `lunora/`-local file calls the
 * generated `defineApp()...extend(() => ({ allowUnauthenticatedShardAccess:
 * true }))` escape hatch (the pattern the `nuxt` / `analog` templates use in
 * `lunora/server.ts`). An app that sets the same field via `@lunora/vite`'s
 * `LunoraPluginOptions` (`vite.config.ts`) or a hand-authored worker entry
 * outside `lunora/` (the `sveltekit` / `astro` / `react-router` /
 * `tanstack-start` template style) is invisible to this lint — a coverage gap,
 * not a false negative this lint claims to catch.
 *
 * Runs only when the codegen feeder supplies config-call evidence; a runtime
 * caller flags nothing. One finding per opted-in `.extend(...)` call site.
 */
const allowUnauthenticatedShardAccessEnabled: Lint = {
    categories: ["SECURITY"],
    description:
        "`.extend(() => ({ allowUnauthenticatedShardAccess: true }))` disables the fail-closed default that denies an unauthenticated shard lookup. Combined with a schema that doesn't enforce `.rls(\"required\")` everywhere (or that leaves a table `.public()`), an unauthenticated caller can shard-hop into another tenant's rows with no row-security guard behind the door.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "allow_unauthenticated_shard_access_enabled",
    remediation:
        'Prefer `authorizeShard` / `authorizeFanOut` (which take precedence over `allowUnauthenticatedShardAccess` and let you allow specific unauthenticated cases) over the blanket opt-out. If the app genuinely needs open shard access, enforce `.rls("required")` on the schema with no `.public()` tables so a missing identity still can\'t read another tenant\'s rows.',
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        const hasRlsGap = context.schema.rlsMode !== "required" || context.schema.tables.some((table) => table.isPublic);

        if (!hasRlsGap) {
            return [];
        }

        return context.configCalls
            .filter((call) => call.callee === "extend" && call.trueKeys.includes("allowUnauthenticatedShardAccess"))
            .map((call) =>
                emit(allowUnauthenticatedShardAccessEnabled, {
                    cacheKey: `allow_unauthenticated_shard_access_enabled:${call.file}:${call.line.toString()}`,
                    detail: `\`.extend(...)\` in ${call.file}:${call.line.toString()} sets \`allowUnauthenticatedShardAccess: true\`, and the schema has an RLS gap (no \`.rls("required")\`, or a \`.public()\` table) — an unauthenticated caller can shard-hop into another tenant's rows with no row-security guard behind the door.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "Unauthenticated shard access enabled on an RLS-gapped schema",
};

export default allowUnauthenticatedShardAccessEnabled;
