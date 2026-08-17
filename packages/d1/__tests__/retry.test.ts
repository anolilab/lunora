import { describe, expect, it, vi } from "vitest";

import { isTransientD1Error, TRANSIENT_D1_ERRORS, withD1Retry } from "../src/retry";

/** No real waiting — the backoff schedule is asserted, not slept through. */
const noSleep = async (): Promise<void> => {};

describe("isTransientD1Error", () => {
    it("recognises the errors Cloudflare says a healthy D1 produces", () => {
        expect.assertions(4);

        expect(isTransientD1Error(new Error("D1 DB storage operation exceeded timeout which caused object to be reset"))).toBe(true);
        expect(isTransientD1Error(new Error("D1_ERROR: Network connection lost"))).toBe(true);
        expect(isTransientD1Error(new Error("Internal error while starting up D1 DB storage caused object to be reset"))).toBe(true);
        expect(isTransientD1Error(new Error("D1 DB's isolate exceeded its memory limit and was reset"))).toBe(true);
    });

    it("matches case-insensitively and inside a wrapped message", () => {
        expect.assertions(2);

        expect(isTransientD1Error(new Error("Error in D1: NETWORK CONNECTION LOST (request id abc123)"))).toBe(true);
        expect(isTransientD1Error("d1_error: network connection lost")).toBe(true);
    });

    it("treats a deterministic failure as permanent", () => {
        expect.assertions(4);

        // These fail identically on every attempt; retrying turns one fast
        // failure into three slow ones and hides the cause.
        expect(isTransientD1Error(new Error("UNIQUE constraint failed: users.email"))).toBe(false);
        expect(isTransientD1Error(new Error('near "SELCT": syntax error'))).toBe(false);
        expect(isTransientD1Error(new Error("no such table: accounts"))).toBe(false);
        expect(isTransientD1Error(new Error("no such column: nope"))).toBe(false);
    });

    it("does not retry a constraint violation even when it mentions an internal error", () => {
        expect.assertions(1);

        // Some drivers wrap constraint failures in generic text; the
        // deterministic signal has to win.
        expect(isTransientD1Error(new Error("Internal error: FOREIGN KEY constraint failed"))).toBe(false);
    });

    it("treats an unrecognised error as permanent", () => {
        expect.assertions(3);

        expect(isTransientD1Error(new Error("something entirely new"))).toBe(false);
        expect(isTransientD1Error(undefined)).toBe(false);
        expect(isTransientD1Error({ nope: true })).toBe(false);
    });

    it("exports the matched substrings for callers extending the policy", () => {
        expect.assertions(1);

        expect(TRANSIENT_D1_ERRORS.length).toBeGreaterThan(0);
    });
});

describe("withD1Retry", () => {
    it("returns the first successful result without retrying", async () => {
        expect.assertions(2);

        const operation = vi.fn<() => Promise<string>>(async () => "ok");
        const result = await withD1Retry(operation, { sleep: noSleep });

        expect(result).toBe("ok");
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("retries a transient failure and succeeds", async () => {
        expect.assertions(2);

        let calls = 0;
        const result = await withD1Retry(
            async () => {
                calls += 1;

                if (calls < 3) {
                    throw new Error("D1_ERROR: Network connection lost");
                }

                return "recovered";
            },
            { sleep: noSleep },
        );

        expect(result).toBe("recovered");
        expect(calls).toBe(3);
    });

    it("gives up after the attempt budget and rethrows the last error", async () => {
        expect.assertions(2);

        let calls = 0;

        await expect(
            withD1Retry(
                async () => {
                    calls += 1;

                    throw new Error("D1_ERROR: Network connection lost");
                },
                { attempts: 3, sleep: noSleep },
            ),
        ).rejects.toThrow(/Network connection lost/u);

        expect(calls).toBe(3);
    });

    it("does not retry a permanent failure", async () => {
        expect.assertions(2);

        let calls = 0;

        await expect(
            withD1Retry(
                async () => {
                    calls += 1;

                    throw new Error("UNIQUE constraint failed: users.email");
                },
                { sleep: noSleep },
            ),
        ).rejects.toThrow(/UNIQUE constraint/u);

        // One attempt: a constraint violation is not going to resolve itself.
        expect(calls).toBe(1);
    });

    it("backs off exponentially, bounded by maxDelayMs", async () => {
        expect.assertions(2);

        const delays: number[] = [];
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);

        try {
            await expect(
                withD1Retry(
                    async () => {
                        throw new Error("network connection lost");
                    },
                    {
                        attempts: 5,
                        baseDelayMs: 100,
                        maxDelayMs: 250,
                        sleep: async (ms) => {
                            delays.push(ms);
                        },
                    },
                ),
            ).rejects.toThrow(/network connection lost/iu);

            // 100, 200, then clamped at 250. Math.random pinned to 1 so full
            // jitter yields the ceiling.
            expect(delays).toStrictEqual([100, 200, 250, 250]);
        } finally {
            randomSpy.mockRestore();
        }
    });

    it("jitters the backoff so retries do not re-converge in lockstep", async () => {
        expect.assertions(2);

        const delays: number[] = [];
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

        try {
            await expect(
                withD1Retry(
                    async () => {
                        throw new Error("network connection lost");
                    },
                    {
                        attempts: 3,
                        baseDelayMs: 100,
                        sleep: async (ms) => {
                            delays.push(ms);
                        },
                    },
                ),
            ).rejects.toThrow(/network connection lost/iu);

            // Half the ceiling, not the ceiling: without jitter every caller
            // that hit the same blip retries together and re-converges on the
            // recovering database as one wave.
            expect(delays).toStrictEqual([50, 100]);
        } finally {
            randomSpy.mockRestore();
        }
    });

    it("reports each retry for logging", async () => {
        expect.assertions(2);

        const seen: number[] = [];

        await expect(
            withD1Retry(
                async () => {
                    throw new Error("network connection lost");
                },
                { attempts: 3, onRetry: (info) => seen.push(info.attempt), sleep: noSleep },
            ),
        ).rejects.toThrow(/network connection lost/iu);

        expect(seen).toStrictEqual([1, 2]);
    });

    it("honours a narrowed retry policy", async () => {
        expect.assertions(2);

        let calls = 0;

        await expect(
            withD1Retry(
                async () => {
                    calls += 1;

                    throw new Error("network connection lost");
                },
                { isRetryable: () => false, sleep: noSleep },
            ),
        ).rejects.toThrow(/network connection lost/iu);

        expect(calls).toBe(1);
    });

    it("runs exactly once with an attempt budget of 1", async () => {
        expect.assertions(2);

        let calls = 0;

        await expect(
            withD1Retry(
                async () => {
                    calls += 1;

                    throw new Error("network connection lost");
                },
                { attempts: 1, sleep: noSleep },
            ),
        ).rejects.toThrow(/network connection lost/iu);

        expect(calls).toBe(1);
    });

    it("rejects a nonsensical attempt budget", async () => {
        expect.assertions(1);

        await expect(withD1Retry(async () => "x", { attempts: 0 })).rejects.toThrow(/`attempts` must be an integer >= 1/u);
    });
});
