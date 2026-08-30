/**
 * Token budgets: a rate limit whose unit is model tokens (or cents) rather than
 * requests.
 *
 * A request limit is the wrong shape for an LLM. One call can cost a hundred
 * tokens or a hundred thousand, so "20 calls a minute per tenant" bounds nothing
 * that matters — a single runaway prompt still empties the account. What has to
 * be bounded is consumption, and consumption is only known once the call
 * returns.
 *
 * So the budget is spent in arrears, which is also how tokens actually work:
 * you cannot un-spend them, and there is nothing to refund.
 *
 * {@link TokenBudget.check} runs before the call: a tenant whose bucket is
 * already empty (or negative, from an expensive previous call) is turned away
 * before spending anything. {@link TokenBudget.record} runs after it, with the
 * real usage — the bucket is allowed to go negative, so a call that blew through
 * the remaining budget completes and the NEXT one is refused until the debt
 * refills away.
 *
 * No estimate, no reservation to reconcile, and no new accounting path: this is
 * a thin composition over the limiter's existing `check`/`limit(reserve)`.
 *
 * The unit is whatever the limit's `capacity` counts. Tokens are the obvious
 * choice; cents work identically if you would rather budget money.
 */
import { enforcedCapacity } from "./algorithms";
import type { RateLimiter } from "./rate-limiter";
import type { RateLimitStatus } from "./types";

/** A budget bound to one named limit — check before the call, record after it. */
interface TokenBudget {
    /**
     * Peek at the budget before spending. `ok: false` means it is exhausted:
     * refuse the call, and `retryAfter` says when it refills. Consumes nothing.
     */
    check: (key: string) => Promise<RateLimitStatus>;

    /**
     * Charge the tokens a call actually used. Always call it, including when the
     * call THREW — a failed generation that consumed input tokens still has to be
     * paid for. `tokens` of `0` is a no-op, so a call that spent nothing costs
     * nothing.
     *
     * The charge is a reservation, so it may take the bucket negative: the tokens
     * are already spent, and refusing to record them would let a single oversized
     * call escape the budget entirely.
     */
    record: (key: string, tokens: number) => Promise<RateLimitStatus>;
}

/**
 * Bind a {@link TokenBudget} to one of a limiter's named limits.
 *
 * ```ts
 * const budget = tokenBudget(limiter, "tokens");
 * const allowed = await budget.check(userId);
 *
 * if (!allowed.ok) {
 *     throw new LunoraError("RATE_LIMITED", `token budget exhausted; retry in ${String(allowed.retryAfter)}ms`);
 * }
 *
 * try {
 *     const { text, usage } = await generateText({ model: ctx.ai.model(), prompt });
 *
 *     await budget.record(userId, usage?.totalTokens ?? 0);
 *
 *     return text;
 * } catch (error) {
 *     // The prompt was still sent — charge what is known, then rethrow.
 *     await budget.record(userId, estimatedInputTokens);
 *
 *     throw error;
 * }
 * ```
 */
const tokenBudget = <Names extends string>(limiter: RateLimiter<Names>, name: Names): TokenBudget => {
    return {
        check: async (key) => limiter.check(name, { key }),
        record: async (key, tokens) => {
            // Nothing spent, nothing to charge — and the limiter rejects a zero count.
            if (!Number.isFinite(tokens) || tokens <= 0) {
                return limiter.check(name, { key });
            }

            // Clamp to the capacity the limiter will actually enforce. It refuses
            // a count larger than capacity outright, and for a token budget that
            // is exactly backwards: a single long-context call over a per-window
            // budget is the ordinary case, and throwing would charge it NOTHING —
            // the one call the budget exists to catch would escape it entirely.
            // Charging the whole bucket is the strongest true statement available.
            //
            // The ceiling is per ALGORITHM (`enforcedCapacity`), not `capacity`:
            // a sliding window ignores `capacity` and enforces `rate`, so a config
            // like `{ kind: "sliding window", rate: 10_000, capacity: 50_000 }`
            // clamped to `capacity` still hands the limiter a count it throws on —
            // the exact outcome this clamp exists to prevent.
            //
            // `getValue` reports the RAW config, while a sharded limit enforces
            // `capacity / shards` on the one bucket this key routes to. Clamping
            // to the raw value would still throw on a sharded budget, so the cap
            // is derived per shard, floored to the positive integer `limit`
            // requires.
            const { config } = await limiter.getValue(name, { key });
            // `limit` only accepts a positive integer, so the floor cannot go
            // below 1. A limit whose per-shard capacity is under one token is
            // unusable by ANY caller — `check` throws on it too — so that is a
            // configuration error to fix at the limit, not something a charge
            // made after the fact can absorb.
            const capacity = Math.max(1, Math.floor(enforcedCapacity(config) / (config.shards ?? 1)));

            return limiter.limit(name, { count: Math.min(Math.ceil(tokens), capacity), key, reserve: true });
        },
    };
};

export type { TokenBudget };
export { tokenBudget };
