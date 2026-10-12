import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeProfiler } from "../src/node-profiler";

/**
 * The inspector is replaced with a session that answers at once, so the lock
 * can be exercised without a real capture. The capture window is a fake timer,
 * which keeps the test independent of wall-clock time.
 */
vi.mock(import("node:inspector"), () => {
    const root = {
        callFrame: { columnNumber: -1, functionName: "(root)", lineNumber: -1, url: "" },
        children: [],
        id: 1,
        selfSize: 0,
    };

    // A constructor that returns the session object, so `new Session()` works without a class.
    const Session = function Session() {
        return {
            connect: (): void => undefined,
            disconnect: (): void => undefined,
            // One payload serves both the CPU shape (`nodes`) and the heap shape (`head`).
            post: (_method: string, _params: unknown, callback: (error: Error | null, result?: unknown) => void): void => {
                callback(null, { profile: { endTime: 0, head: root, nodes: [root], samples: [], startTime: 0, timeDeltas: [] } });
            },
        };
    };

    return { Session } as unknown as typeof import("node:inspector");
});

/** Advances fake time in steps until `finished` reports true. */
const advanceUntilFinished = async (finished: () => boolean): Promise<void> => {
    if (finished()) {
        return;
    }

    await vi.advanceTimersByTimeAsync(100);
    await advanceUntilFinished(finished);
};

/**
 * Advances fake time until `capture` settles. The capture registers its window
 * timer only after a few inspector round trips, so one advance can run before
 * the timer exists and leave it waiting forever.
 */
const runCaptureToEnd = async (capture: Promise<Uint8Array>): Promise<Uint8Array> => {
    let finished = false;
    const mark = (): void => {
        finished = true;
    };

    capture.then(mark).catch(mark);
    await advanceUntilFinished(() => finished);

    return capture;
};

describe("createNodeProfiler lock", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("refuses a capture from any instance while one runs, then accepts one again once it finishes", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const first = createNodeProfiler().capture({ durationMs: 1000, profileType: "cpu" });

        await expect(createNodeProfiler().capture({ durationMs: 1000, profileType: "heap" })).rejects.toMatchObject({ code: "CONFLICT" });

        const bytes = await runCaptureToEnd(first);

        expect(bytes[0]).toBe(0x1f);

        await expect(runCaptureToEnd(createNodeProfiler().capture({ durationMs: 1000, profileType: "heap" }))).resolves.toBeInstanceOf(Uint8Array);
    });

    it("does not hold the lock after a refused request", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        // An invalid request is refused before the lock is taken, so this only checks the lock is free after it.
        await expect(createNodeProfiler().capture({ durationMs: 10, profileType: "cpu" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const capture = createNodeProfiler().capture({ durationMs: 1000, profileType: "cpu" });

        await expect(runCaptureToEnd(capture)).resolves.toBeInstanceOf(Uint8Array);
    });
});
