import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Cloudflare's ceiling on subrequests to internal services (Durable Objects,
 * KV, R2, D1) within one Worker invocation. 1,000 on the Free plan; on Paid it
 * matches the configured subrequest limit, which defaults to 10,000.
 *
 * A cross-shard read issues one such subrequest per shard, so the shard count of
 * a fan-out is bounded by whichever of those applies to the account.
 */
const FREE_PLAN_INTERNAL_SUBREQUESTS = 1000;

/**
 * Where the warning starts.
 *
 * Deliberately well under the Free ceiling. The remediation for a wide fan-out
 * is a design change — narrow the read to a shard subset, or roll the answer up
 * through a `.global()` table — and that is not advice anyone can act on in the
 * request that fails. It also cannot be a hard cap: the real ceiling depends on
 * the account's plan and configured limit, so refusing at a fixed number would
 * break deployments that work today. Warn, name the number, let the operator
 * decide.
 */
const WARN_AT_SHARDS = 500;

/**
 * `fan_out_breadth` — flag a shard set wide enough that a cross-shard read over
 * it would approach the per-invocation subrequest ceiling.
 *
 * `.shardBy(key)` makes reads cheap by keeping each one on a single Durable
 * Object. A query that cannot be answered from one shard fans out instead, and
 * the coordinator issues one Durable Object RPC per shard. Those are in-house
 * subrequests, so they do not consume the six external connection slots — but
 * they do count against the per-invocation subrequest ceiling, and that ceiling
 * is reached by breadth alone. Bounded concurrency does not help: it paces the
 * fan-out, it does not shrink it.
 *
 * This measures **capacity, not observed fan-out**, and the distinction is the
 * whole reason for the wording. The `shardTraffic` feeder reports one entry per
 * live shard — the studio backend supplies no group at all, and the
 * Analytics-Engine feeder groups by shard TABLE over its whole retention window
 * — so neither carries "how many shards one invocation actually touched". What
 * they do carry is how wide the shard set is, which is the ceiling on any fan-out
 * over it. An app whose every read is shard-pinned is never at risk; it is told
 * how much room a cross-shard read would have, not that it made one.
 *
 * Idle shards are excluded, matching `hot_shard`: a shard with no traffic in the
 * window is not evidence of anything, and counting it would let a long tail of
 * dormant tenants raise the alarm on its own.
 */
const fanOutBreadth: Lint = {
    categories: ["PERFORMANCE"],
    description: "A shard set is wide enough that a cross-shard read over it would approach the per-invocation subrequest ceiling.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "fan_out_breadth",
    remediation: "Keep reads shard-pinned, or roll cross-shard answers up through a `.global()` table.",
    run: (context) => {
        // Only active shards, for the same reason `hot_shard` filters them.
        const active = (context.shardTraffic ?? []).filter((shard) => shard.requests > 0);

        if (active.length === 0) {
            return [];
        }

        // Grouped where the feeder supplies a group, since the ceiling applies to
        // one invocation over one shard set rather than to the deployment total.
        const byGroup = new Map<string, number>();

        for (const entry of active) {
            const group = entry.group ?? "";

            byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
        }

        return [...byGroup]
            .filter(([, shards]) => shards >= WARN_AT_SHARDS)
            .map(([group, shards]) =>
                emit(fanOutBreadth, {
                    cacheKey: `fan_out_breadth:${group}`,
                    detail: `${group === "" ? "This deployment" : `Shard group "${group}"`} has ${String(shards)} active shards, so a cross-shard read over it would issue ${String(shards)} Durable Object subrequests — against a ceiling of ${String(FREE_PLAN_INTERNAL_SUBREQUESTS)} per invocation on the Free plan (higher on Paid, but finite). Shard-pinned reads are unaffected.`,
                    metadata: { freePlanCeiling: FREE_PLAN_INTERNAL_SUBREQUESTS, group, shards },
                }),
            );
    },
    source: "runtime",
    title: "Shard set wide enough to strain a cross-shard read",
};

export default fanOutBreadth;
