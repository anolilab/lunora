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
 * `fan_out_breadth` — flag a cross-shard read whose shard count is approaching
 * the per-invocation subrequest ceiling.
 *
 * `.shardBy(key)` makes reads cheap by keeping each one on a single Durable
 * Object. A query that cannot be answered from one shard fans out instead, and
 * the coordinator issues one Durable Object RPC per shard. Those are in-house
 * subrequests, so they do not consume the six external connection slots — but
 * they do count against the per-invocation subrequest ceiling, and that ceiling
 * is reached by breadth alone. Bounded concurrency does not help: it paces the
 * fan-out, it does not shrink it.
 *
 * The shard count comes from the same `shardTraffic` feeder `hot_shard` reads,
 * so this costs no extra cross-shard work — the distribution is already
 * collected. Where `hot_shard` looks at the *shape* of that distribution (one
 * shard taking most of the traffic), this one looks only at its *size*.
 */
const fanOutBreadth: Lint = {
    categories: ["PERFORMANCE"],
    description: "A cross-shard read fans out over enough shards to approach the per-invocation subrequest ceiling.",
    facing: "INTERNAL",
    level: "WARN",
    name: "fan_out_breadth",
    remediation: "Narrow the read to a shard subset, or roll the answer up through a `.global()` table.",
    run: (context) => {
        const traffic = context.shardTraffic ?? [];

        if (traffic.length === 0) {
            return [];
        }

        // Group first: the ceiling applies per invocation, and one invocation
        // fans out over one function's shard set — not over every shard the
        // deployment happens to have.
        const byGroup = new Map<string, number>();

        for (const entry of traffic) {
            const group = entry.group ?? "";

            byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
        }

        return [...byGroup]
            .filter(([, shards]) => shards >= WARN_AT_SHARDS)
            .map(([group, shards]) =>
                emit(fanOutBreadth, {
                    cacheKey: `fan_out_breadth:${group}`,
                    detail: `${group === "" ? "A cross-shard read" : `Function "${group}"`} fans out over ${String(shards)} shards. One Durable Object subrequest each, against a ceiling of ${String(FREE_PLAN_INTERNAL_SUBREQUESTS)} internal subrequests per invocation on the Free plan (higher on Paid, but finite).`,
                    metadata: { freePlanCeiling: FREE_PLAN_INTERNAL_SUBREQUESTS, group, shards },
                }),
            );
    },
    source: "runtime",
    title: "Wide cross-shard fan-out",
};

export default fanOutBreadth;
