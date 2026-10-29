import { setFlagsFromString } from "node:v8";
import { gunzipSync } from "node:zlib";

import { Profile } from "pprof-format";
import { describe, expect, it } from "vitest";

import { createNodeProfiler, parseNodeProfileRequest } from "../src/node-profiler";

/**
 * Work the CPU profile attributes to a named frame. Once V8 optimises the loop
 * it can inline this function into its caller, and every sample is then
 * attributed to the caller, which is `(anonymous)` or the test body. Measured:
 * the frame was missing in roughly three of four runs with optimisation on.
 * The CPU test therefore turns optimisation off for the duration (see there).
 */
const busyLoopForProfiler = (untilMs: number): number => {
    let total = 0;

    while (Date.now() < untilMs) {
        for (let index = 0; index < 10_000; index += 1) {
            total += Math.sqrt(index);
        }
    }

    return total;
};

/** Allocations kept alive for the window, so the heap profile still sees them when sampling stops. */
const retained: unknown[] = [];

const allocateForProfiler = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
        retained.push(Array.from({ length: 256 }).fill(index));
    }
};

const decodeGzip = (bytes: Uint8Array): Profile => Profile.decode(gunzipSync(bytes));

const str = (profile: Profile, index: number | bigint): string => profile.stringTable.strings[Number(index)] ?? "";

/** Every function name the profile mentions, whether or not a sample reached it. */
const functionNames = (profile: Profile): string[] => profile.function.map((fn) => str(profile, fn.name));

/**
 * Runs `work` once per turn of the event loop until `done` settles. Driven by
 * `setImmediate` rather than `await` so the sampler sees the work between turns.
 */
const runUntilSettled = (done: Promise<unknown>, work: () => void): Promise<void> =>
    new Promise((resolve) => {
        let finished = false;
        const finish = (): void => {
            finished = true;
            resolve();
        };

        done.then(finish).catch(finish);

        const step = (): void => {
            if (finished) {
                return;
            }

            work();
            setImmediate(step);
        };

        step();
    });

describe("parseNodeProfileRequest", () => {
    it.each([
        ["a duration under the floor", { durationMs: 999, profileType: "cpu" }],
        ["a duration over the ceiling", { durationMs: 50_001, profileType: "cpu" }],
        ["a fractional duration", { durationMs: 1500.5, profileType: "cpu" }],
        ["a non-numeric duration", { durationMs: "5000", profileType: "cpu" }],
        ["a missing duration", { durationMs: undefined, profileType: "cpu" }],
        ["an unknown profile type", { durationMs: 1000, profileType: "trace" }],
        ["a missing profile type", { durationMs: 1000, profileType: undefined }],
    ])("rejects %s with BAD_REQUEST", (_label, input) => {
        expect.assertions(1);

        let thrown: unknown;

        try {
            parseNodeProfileRequest(input);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ code: "BAD_REQUEST" });
    });

    it("accepts both bounds and both types", () => {
        expect.assertions(2);

        expect(parseNodeProfileRequest({ durationMs: 1000, profileType: "cpu" })).toStrictEqual({ durationMs: 1000, profileType: "cpu" });
        expect(parseNodeProfileRequest({ durationMs: 50_000, profileType: "heap" })).toStrictEqual({ durationMs: 50_000, profileType: "heap" });
    });
});

describe("createNodeProfiler", () => {
    it("captures a CPU profile of a busy function from the real inspector", async () => {
        expect.assertions(3);

        // Keep the busy frame unoptimised while this capture runs, so V8 cannot inline it into its caller.
        setFlagsFromString("--no-opt");

        try {
            const capture = createNodeProfiler().capture({ durationMs: 1000, profileType: "cpu" });

            await runUntilSettled(capture, () => {
                busyLoopForProfiler(Date.now() + 20);
            });

            const bytes = await capture;
            const profile = decodeGzip(bytes);
            const sampled = profile.sample.reduce((total, sample) => total + Number(sample.value[0] ?? 0), 0);

            expect(bytes[0]).toBe(0x1f);
            expect(sampled).toBeGreaterThan(0);
            expect(functionNames(profile)).toContain("busyLoopForProfiler");
        } finally {
            setFlagsFromString("--opt");
        }
    }, 20_000);

    it("captures a heap profile that includes the allocating function from the real inspector", async () => {
        expect.assertions(2);

        const capture = createNodeProfiler().capture({ durationMs: 1000, profileType: "heap" });

        // Capped, so a fast loop cannot grow the heap by hundreds of megabytes.
        await runUntilSettled(capture, () => {
            if (retained.length < 5000) {
                allocateForProfiler(50);
            }
        });

        const profile = decodeGzip(await capture);

        retained.length = 0;

        expect(profile.sample.length).toBeGreaterThan(0);
        expect(functionNames(profile)).toContain("allocateForProfiler");
    }, 20_000);
});
