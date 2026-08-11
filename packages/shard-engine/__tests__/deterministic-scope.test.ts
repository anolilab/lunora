import { describe, expect, it } from "vitest";

import { mulberry32, withDeterministicScope } from "../src/deterministic-scope";

describe("withDeterministicScope", () => {
    it("freezes the clock and seeds randomness for the duration of the body", async () => {
        expect.assertions(3);

        const run = async (seed: string) =>
            withDeterministicScope({ now: 1_700_000_000_000, seed }, async () => {
                const first = Date.now();

                await Promise.resolve();

                // eslint-disable-next-line sonarjs/pseudo-random -- asserting the SCOPE's seeded PRNG is exactly the point; nothing security-sensitive derives from it
                return { first, random: Math.random(), second: Date.now() };
            });

        const seen = await run("shard:mut-1");

        // The classic bug this closes: one handler, two clock reads, two answers.
        expect([seen.first, seen.second]).toStrictEqual([1_700_000_000_000, 1_700_000_000_000]);
        // Seeded, so the sequence is a function of the seed, not host entropy...
        await expect(run("shard:mut-1")).resolves.toMatchObject({ random: seen.random });
        // ...and a different mutation gets a different one.
        await expect(run("shard:mut-2")).resolves.not.toMatchObject({ random: seen.random });
    });

    it("refuses network I/O inside the scope", async () => {
        expect.assertions(1);

        await expect(
            withDeterministicScope({ now: 1, seed: "s" }, async () => {
                await globalThis.fetch("https://example.com");
            }),
        ).rejects.toThrow("fetch is not available inside a mutation");
    });

    it("restores the ambient sources, including when the body throws", async () => {
        expect.assertions(3);

        const realNow = Date.now;
        const realRandom = Math.random;
        const realFetch = globalThis.fetch;

        await expect(
            withDeterministicScope({ now: 1, seed: "s" }, () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        expect(Date.now).toBe(realNow);
        expect([Math.random, globalThis.fetch]).toStrictEqual([realRandom, realFetch]);
    });

    it("gives two different seeds two different sequences", () => {
        expect.assertions(1);

        expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    });
});
