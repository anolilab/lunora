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

    it("keeps budgets separate per key", async () => {
        expect.assertions(1);

        const budget = tokenBudget(limiter(), "tokens");

        await budget.record("user-c", 1000);

        await expect(budget.check("user-d")).resolves.toMatchObject({ ok: true });
    });
});
