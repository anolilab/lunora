import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags the open-shard option set to anything but a literal `false` in the app
 * being deployed. A shorthand, getter, method or non-boolean value has no literal
 * to read, so it is flagged too.
 *
 * Every template ships the flag so its demo works before auth exists, with a
 * "before deploying" comment beside it; the runtime only logs a warning when it
 * sees it. Unlike `allow_unauthenticated_shard_access_enabled` (a WARN that fires
 * only when the schema also has an RLS gap), this is the deploy-time stop: open
 * shard access is a setting nobody should ship by accident, so it is an ERROR
 * whatever the schema says, and `lunora deploy` refuses it unless
 * `--allow-open-shards` says the open posture is deliberate.
 *
 * **Evidence**: `context.openShardAccess`, supplied by `lunora deploy`'s own
 * project scan. Codegen does not supply it — a codegen-fed ERROR would fail every
 * template's CI build — so `lunora advisor` and the Studio never show it.
 */
const openShardAccess: Lint = {
    categories: ["SECURITY"],
    description:
        "The app enables, or may enable, `allowUnauthenticatedShardAccess`, so any caller — signed in or not — may target any shard. The templates ship it for the local demo; it must not reach production by accident.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "open_shard_access",
    remediation:
        'Add auth and replace the flag with a shard gate: `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`. If open access is genuinely intended, deploy with `--allow-open-shards`.',
    run: (context) =>
        (context.openShardAccess ?? []).map((site) =>
            emit(openShardAccess, {
                cacheKey: `open_shard_access:${site.file}:${site.line.toString()}`,
                detail: `${site.file}:${site.line.toString()} enables the open-shard option (any value but false) — any caller may target any shard. Gate shards with \`authorizeShard\` before deploying.`,
                metadata: { file: site.file, line: site.line },
            }),
        ),
    source: "static",
    title: "Open shard access",
};

export default openShardAccess;
