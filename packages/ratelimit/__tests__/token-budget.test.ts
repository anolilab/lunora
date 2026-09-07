import { describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter";
import { tokenBudget } from "../src/token-budget";

const limiter = () => new RateLimiter({ config: { tokens: { capacity: 1000, kind: "token bucket", period: 60_000, rate: 1000 } } });

describe("tokenBudget", () => {
    it("allows a call while the budget holds and refuses once it is spent", async () => {
        expect.assertions(3);

        const budget = tokenBudget(limiter(), "tokens");

        await expect(budget.check("user-a")).resolves.toMatchObject({ ok: true });

        await budget.record("user-a", 900);

        await expect(budget.check("user-a")).resolves.toMatchObject({ ok: true });

        // One oversized call takes the bucket negative — the NEXT call is refused,
        // which is the only enforcement point that exists for a cost known in arrears.
        await budget.record("user-a", 500);

        await expect(budget.check("user-a")).resolves.toMatchObject({ ok: false });
    });

    it("charges nothing for a call that used no tokens", async () => {
        expect.assertions(1);

        const shared = limiter();
        const budget = tokenBudget(shared, "tokens");

        await budget.record("user-b", 0);

        await expect(shared.getValue("tokens", { key: "user-b" })).resolves.toMatchObject({ value: 1000 });
    });

    it("charges an oversized call the whole bucket instead of throwing", async () => {
        expect.assertions(2);

        const shared = limiter();
        const budget = tokenBudget(shared, "tokens");

        // A single long-context call past the per-window capacity is ordinary for
        // an LLM. Refusing to record it would let the one call the budget exists
        // to catch escape it completely.
        await expect(budget.record("user-x", 1500)).resolves.toMatchObject({ ok: true });
        await expect(budget.check("user-x")).resolves.toMatchObject({ ok: false });
    });

    it("clamps to the per-shard capacity a sharded limit actually enforces", async () => {
        expect.assertions(2);

        // 4 shards → each bucket enforces 1000/4 = 250. Clamping to the raw 1000
        // would exceed the enforced capacity and throw, leaving the call
        // uncharged — the exact escape this clamp exists to prevent.
        const sharded = new RateLimiter({ config: { tokens: { capacity: 1000, kind: "token bucket", period: 60_000, rate: 1000, shards: 4 } } });
        const budget = tokenBudget(sharded, "tokens");

        await expect(budget.record("user-s", 5000)).resolves.toMatchObject({ ok: true });
        await expect(budget.check("user-s")).resolves.toMatchObject({ ok: false });
    });

    it("clamps a sliding-window budget to rate, which is what it enforces", async () => {
        expect.assertions(2);

        // `capacity` is documented as ignored by sliding windows — their ceiling is
        // `rate`. Clamping to `capacity` hands `limit` a count above the enforced
        // ceiling, which throws an INTERNAL error out of `record` and charges
        // nothing, letting the oversized call escape the budget entirely.
        const sliding = new RateLimiter({ config: { tokens: { capacity: 50_000, kind: "sliding window", period: 60_000, rate: 10_000 } } });
        const budget = tokenBudget(sliding, "tokens");

        await expect(budget.record("user-w", 20_000)).resolves.toMatchObject({ ok: true });
        await expect(budget.check("user-w")).resolves.toMatchObject({ ok: false });
    });

    it("keeps budgets separate per key", async () => {
        expect.assertions(1);

        const budget = tokenBudget(limiter(), "tokens");

        await budget.record("user-c", 1000);

        await expect(budget.check("user-d")).resolves.toMatchObject({ ok: true });
    });
});
