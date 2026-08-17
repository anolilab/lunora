import type { SqlCtxExec } from "@lunora/sql-store";
import { describe, expect, it, vi } from "vitest";

import { D1TimeoutError, isReadOnlyD1Sql, isTransientD1Error, retryingExec, withD1Retry } from "../src/retry";

/** No real waiting — the backoff schedule is asserted, not slept through. */
const noSleep = async (): Promise<void> => {};

/**
 * Run `body` with `Date.now` reading a clock the test advances, so elapsed-time
 * behaviour (deadlines, the slow-failure guard) is exercised without waiting.
 */
const withFakeClock = async (body: (advance: (ms: number) => void) => Promise<void>): Promise<void> => {
    let clock = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
        await body((ms) => {
            clock += ms;
        });
    } finally {
        spy.mockRestore();
    }
};

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
        expect.assertions(6);

        // These fail identically on every attempt; retrying turns one fast
        // failure into three slow ones and hides the cause. None of them
        // matches a needle, so no deny list is needed to exclude them.
        expect(isTransientD1Error(new Error("UNIQUE constraint failed: users.email"))).toBe(false);
        expect(isTransientD1Error(new Error('near "SELCT": syntax error'))).toBe(false);
        expect(isTransientD1Error(new Error("no such table: accounts"))).toBe(false);
        expect(isTransientD1Error(new Error("no such column: nope"))).toBe(false);
        expect(isTransientD1Error(new Error("D1_ERROR: internal error: too many SQL variables"))).toBe(false);
        expect(isTransientD1Error(new Error("Internal error: FOREIGN KEY constraint failed"))).toBe(false);
    });

    it("treats an unrecognised error as permanent", () => {
        expect.assertions(3);

        expect(isTransientD1Error(new Error("something entirely new"))).toBe(false);
        expect(isTransientD1Error(undefined)).toBe(false);
        expect(isTransientD1Error({ nope: true })).toBe(false);
    });
});

describe("isReadOnlyD1Sql", () => {
    it("accepts the statements that cannot have applied anything", () => {
        expect.assertions(4);

        expect(isReadOnlyD1Sql("SELECT * FROM users")).toBe(true);
        expect(isReadOnlyD1Sql("  \n select 1")).toBe(true);
        expect(isReadOnlyD1Sql("PRAGMA table_info('users')")).toBe(true);
        expect(isReadOnlyD1Sql("EXPLAIN QUERY PLAN SELECT 1")).toBe(true);
    });

    it("rejects a write, including the ones D1 runs through all()", () => {
        expect.assertions(5);

        // The one that matters: `@lunora/sql-store` runs its optimistic-
        // concurrency compare-and-swap as `UPDATE … RETURNING "id"` through
        // `exec.all`. Re-running it reports a conflict for a write that landed.
        expect(isReadOnlyD1Sql('UPDATE "posts" SET "title" = ? WHERE "id" = ? RETURNING "id"')).toBe(false);
        expect(isReadOnlyD1Sql('DELETE FROM "posts" WHERE "id" = ? RETURNING "id"')).toBe(false);
        expect(isReadOnlyD1Sql("INSERT INTO seen (id) VALUES (?) RETURNING id")).toBe(false);
        expect(isReadOnlyD1Sql("CREATE TABLE IF NOT EXISTS t (id TEXT)")).toBe(false);
        // A CTE may end in UPDATE; unprovable means unretried.
        expect(isReadOnlyD1Sql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
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

    it("backs off exponentially, bounded by the delay ceiling", async () => {
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
                        attempts: 7,
                        sleep: async (ms) => {
                            delays.push(ms);
                        },
                    },
                ),
            ).rejects.toThrow(/network connection lost/iu);

            // 50, 100, 200, 400, 800, then clamped at 1000. Math.random pinned
            // to 1 so full jitter yields the ceiling.
            expect(delays).toStrictEqual([50, 100, 200, 400, 800, 1000]);
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
                        sleep: async (ms) => {
                            delays.push(ms);
                        },
                    },
                ),
            ).rejects.toThrow(/network connection lost/iu);

            // Half the ceiling, not the ceiling: without jitter every caller
            // that hit the same blip retries together and re-converges on the
            // recovering database as one wave.
            expect(delays).toStrictEqual([25, 50]);
        } finally {
            randomSpy.mockRestore();
        }
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

describe("stall handling", () => {
    /** A promise that never settles — the 30-second D1 stall, without the wait. */
    const stall = async (): Promise<never> => new Promise<never>(() => {});

    it("abandons an attempt that stalls past timeoutMs", async () => {
        expect.assertions(2);

        const started = Date.now();

        await expect(withD1Retry(stall, { attempts: 1, timeoutMs: 20 })).rejects.toThrow(D1TimeoutError);

        // The point of the whole feature: the caller stops waiting.
        expect(Date.now() - started).toBeLessThan(500);
    });

    it("names the timeout and warns the underlying call may still run", async () => {
        expect.assertions(2);

        const error = await withD1Retry(stall, { attempts: 1, timeoutMs: 10 }).catch((error_: unknown) => error_ as D1TimeoutError);

        expect(error.timeoutMs).toBe(10);
        // The subrequest is not cancelled, only abandoned — say so.
        expect(error.message).toMatch(/may still be running/u);
    });

    it("retries after abandoning a stalled attempt", async () => {
        expect.assertions(2);

        let calls = 0;
        const result = await withD1Retry(
            async () => {
                calls += 1;

                if (calls === 1) {
                    return stall();
                }

                return "recovered";
            },
            { sleep: noSleep, timeoutMs: 20 },
        );

        // A stalled attempt is retryable by definition — nothing came back to
        // classify, so it cannot be judged permanent.
        expect(result).toBe("recovered");
        expect(calls).toBe(2);
    });

    it("abandons an in-flight attempt once deadlineMs is spent", async () => {
        expect.assertions(2);

        const started = Date.now();

        // No timeoutMs: the deadline alone has to bound the attempt. Checking
        // it only between attempts leaves the first one running forever.
        await expect(withD1Retry(stall, { deadlineMs: 150, sleep: noSleep })).rejects.toThrow(D1TimeoutError);

        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("stops retrying once the deadline is spent instead of compounding timeouts", async () => {
        expect.assertions(2);

        await withFakeClock(async (advance) => {
            let calls = 0;

            await expect(
                withD1Retry(
                    async () => {
                        calls += 1;
                        // Each attempt burns most of the budget.
                        advance(30_000);

                        throw new Error("network connection lost");
                    },
                    { attempts: 10, deadlineMs: 45_000, sleep: noSleep },
                ),
            ).rejects.toThrow(/network connection lost/u);

            // Without a deadline this would run all 10 attempts — 300s of
            // stall. The budget stops it after the second.
            expect(calls).toBe(2);
        });
    });

    it("never sleeps a backoff the deadline cannot afford", async () => {
        expect.assertions(2);

        await withFakeClock(async (advance) => {
            const delays: number[] = [];
            const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);

            try {
                await expect(
                    withD1Retry(
                        async () => {
                            advance(30);

                            throw new Error("network connection lost");
                        },
                        {
                            attempts: 5,
                            deadlineMs: 60,
                            sleep: async (ms) => {
                                delays.push(ms);
                                advance(ms);
                            },
                        },
                    ),
                ).rejects.toThrow(/network connection lost/u);

                // Ceiling is 50ms, but only 30ms of budget is left.
                expect(delays).toStrictEqual([30]);
            } finally {
                randomSpy.mockRestore();
            }
        });
    });

    it("does not retry a slow failure when nothing bounds the operation", async () => {
        expect.assertions(2);

        await withFakeClock(async (advance) => {
            let calls = 0;

            await expect(
                withD1Retry(
                    async () => {
                        calls += 1;
                        // The reported D1 failure mode: a 30-second hang that
                        // then errors.
                        advance(30_000);

                        throw new Error("network connection lost");
                    },
                    { sleep: noSleep },
                ),
            ).rejects.toThrow(/network connection lost/u);

            // Three attempts here is a 90-second request instead of a
            // 30-second one — the amplification the defaults must not ship.
            expect(calls).toBe(1);
        });
    });

    it("still retries a fast failure when nothing bounds the operation", async () => {
        expect.assertions(2);

        await withFakeClock(async (advance) => {
            let calls = 0;

            await expect(
                withD1Retry(
                    async () => {
                        calls += 1;
                        advance(5);

                        throw new Error("network connection lost");
                    },
                    { sleep: noSleep },
                ),
            ).rejects.toThrow(/network connection lost/u);

            expect(calls).toBe(3);
        });
    });

    it("clears its timer on the success path", async () => {
        expect.assertions(1);

        const clearSpy = vi.spyOn(globalThis, "clearTimeout");

        try {
            await withD1Retry(async () => "fast", { timeoutMs: 5000 });

            // A Worker leaving a 5s timer armed per query keeps the isolate
            // alive for no reason.
            expect(clearSpy).toHaveBeenCalledTimes(1);
        } finally {
            clearSpy.mockRestore();
        }
    });

    it("runs without a timeout when none is set", async () => {
        expect.assertions(1);

        await expect(withD1Retry(async () => "ok", { sleep: noSleep })).resolves.toBe("ok");
    });
});

describe("retryingExec", () => {
    const failingExec = (): { calls: string[]; exec: SqlCtxExec } => {
        const calls: string[] = [];

        return {
            calls,
            exec: {
                all: async (sql) => {
                    calls.push(sql);

                    throw new Error("D1_ERROR: Network connection lost");
                },
                run: async (sql) => {
                    calls.push(sql);

                    throw new Error("D1_ERROR: Network connection lost");
                },
            },
        };
    };

    it("retries a read", async () => {
        expect.assertions(2);

        const { calls, exec } = failingExec();

        await expect(retryingExec(exec, { sleep: noSleep }).all("SELECT * FROM posts", [])).rejects.toThrow(/Network connection lost/u);

        expect(calls).toHaveLength(3);
    });

    it("does not retry an UPDATE … RETURNING running through all()", async () => {
        expect.assertions(2);

        const { calls, exec } = failingExec();

        // The optimistic-concurrency compare-and-swap `@lunora/sql-store`
        // issues. A retry after a lost response finds the guard clause no
        // longer matching and reports a conflict for a write that applied.
        await expect(retryingExec(exec, { sleep: noSleep }).all('UPDATE "posts" SET "title" = ? WHERE "id" = ? RETURNING "id"', ["x", "1"])).rejects.toThrow(
            /Network connection lost/u,
        );

        expect(calls).toHaveLength(1);
    });

    it("passes writes through untouched", async () => {
        expect.assertions(2);

        const { calls, exec } = failingExec();
        const batch = vi.fn<NonNullable<SqlCtxExec["batch"]>>(async () => {});

        await expect(retryingExec({ ...exec, batch }, { sleep: noSleep }).run("INSERT INTO posts (id) VALUES (?)", ["1"])).rejects.toThrow(
            /Network connection lost/u,
        );

        expect(calls).toHaveLength(1);
    });

    it("keeps the exec's optional batch seam", async () => {
        expect.assertions(1);

        const { exec } = failingExec();
        const batch = vi.fn<NonNullable<SqlCtxExec["batch"]>>(async () => {});

        await retryingExec({ ...exec, batch }).batch?.([{ params: [], sql: "INSERT INTO posts (id) VALUES ('1')" }]);

        expect(batch).toHaveBeenCalledTimes(1);
    });
});
