/**
 * Token bucket — the per-cell API budget primitive (CLOUD-PLAN.md §2.5). Every
 * Cloudflare API call a cell makes (provisioning, script upload, secrets) is
 * gated through one of these so a cell never exceeds the account limit of
 * **1,200 requests / 5 minutes**. Deterministic and clock-injectable so the
 * rate logic is unit-testable without timers.
 */

export interface TokenBucketOptions {
    /** Maximum tokens held at once (burst capacity). */
    capacity: number;
    /** Injected clock (ms epoch). Defaults to `Date.now`. */
    now?: () => number;
    /** Tokens replenished over each `windowMs`. */
    refillPerWindow: number;
    /** Refill window in milliseconds. */
    windowMs: number;
}

export class TokenBucket {
    private readonly capacity: number;

    private lastRefill: number;

    private readonly now: () => number;

    private readonly ratePerMs: number;

    private tokens: number;

    public constructor(options: TokenBucketOptions) {
        this.capacity = options.capacity;
        this.now = options.now ?? Date.now;
        this.ratePerMs = options.refillPerWindow / options.windowMs;
        this.tokens = options.capacity;
        this.lastRefill = this.now();
    }

    /** Whole tokens currently available. */
    public available(at: number = this.now()): number {
        this.refill(at);

        return Math.floor(this.tokens);
    }

    /** Milliseconds until at least one token is available (0 if one is ready now). */
    public msUntilNext(at: number = this.now()): number {
        this.refill(at);

        if (this.tokens >= 1) {
            return 0;
        }

        return Math.ceil((1 - this.tokens) / this.ratePerMs);
    }

    /** Consume one token if available; returns whether it was granted. */
    public tryRemove(at: number = this.now()): boolean {
        this.refill(at);

        if (this.tokens >= 1) {
            this.tokens -= 1;

            return true;
        }

        return false;
    }

    private refill(at: number): void {
        const elapsed = at - this.lastRefill;

        if (elapsed <= 0) {
            return;
        }

        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
        this.lastRefill = at;
    }
}

/** Cloudflare's documented client-API limit: 1,200 requests / 5 minutes per account. */
export const cloudflareAccountBudget = (now?: () => number): TokenBucket =>
    new TokenBucket({ capacity: 1200, now, refillPerWindow: 1200, windowMs: 5 * 60 * 1000 });
