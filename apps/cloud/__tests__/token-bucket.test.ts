import { describe, expect, it } from "vitest";

import { cloudflareAccountBudget, TokenBucket } from "../src/deploy/token-bucket";

describe(TokenBucket, () => {
    it("starts full and drains one token per removal", () => {
        const clock = 0;
        const bucket = new TokenBucket({ capacity: 3, now: () => clock, refillPerWindow: 3, windowMs: 3000 });

        expect(bucket.available(clock)).toBe(3);
        expect(bucket.tryRemove(clock)).toBe(true);
        expect(bucket.tryRemove(clock)).toBe(true);
        expect(bucket.tryRemove(clock)).toBe(true);
        expect(bucket.tryRemove(clock)).toBe(false);
        expect(bucket.available(clock)).toBe(0);
    });

    it("refills continuously over the window", () => {
        let clock = 0;
        const bucket = new TokenBucket({ capacity: 3, now: () => clock, refillPerWindow: 3, windowMs: 3000 });

        // Drain.
        bucket.tryRemove(clock);
        bucket.tryRemove(clock);
        bucket.tryRemove(clock);

        expect(bucket.tryRemove(clock)).toBe(false);

        // 1 token / 1000ms.
        clock = 1000;

        expect(bucket.tryRemove(clock)).toBe(true);
        expect(bucket.tryRemove(clock)).toBe(false);

        // msUntilNext reflects the partial refill.
        expect(bucket.msUntilNext(clock)).toBe(1000);

        clock = 2000;

        expect(bucket.msUntilNext(clock)).toBe(0);
    });

    it("never exceeds capacity no matter how long it sits idle", () => {
        let clock = 0;
        const bucket = new TokenBucket({ capacity: 5, now: () => clock, refillPerWindow: 5, windowMs: 5000 });

        clock = 1_000_000;

        expect(bucket.available(clock)).toBe(5);
    });

    it("models the Cloudflare account budget (1200 / 5 min)", () => {
        const bucket = cloudflareAccountBudget(() => 0);

        expect(bucket.available(0)).toBe(1200);
    });
});
