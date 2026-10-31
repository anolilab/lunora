import { afterEach, describe, expect, it, vi } from "vitest";

import guardCleanup from "../../src/util/termination-guard";

/** The handler `guardCleanup` itself registered for `signal`, so no other listener of the test process is invoked. */
const registered = (signal: NodeJS.Signals, arm: () => () => void): { disarm: () => void; handler: () => void } => {
    const before = new Set(process.listeners(signal));
    const disarm = arm();
    const handler = process.listeners(signal).find((listener) => !before.has(listener));

    if (handler === undefined) {
        throw new Error(`guardCleanup registered no ${signal} handler`);
    }

    return { disarm, handler };
};

describe("guardCleanup", () => {
    const disarms: (() => void)[] = [];

    afterEach(() => {
        for (const disarm of disarms.splice(0)) {
            disarm();
        }
    });

    it("keeps waiting for a cleanup in flight when a second signal arrives, instead of exiting under it", async () => {
        expect.assertions(3);

        let finish: () => void = () => undefined;
        const cleanup = vi.fn<() => Promise<void>>(
            async () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        let exited: ((code: number) => void) | undefined;
        const exitedWith = new Promise<number>((resolve) => {
            exited = resolve;
        });
        const exit = vi.fn<(code: number) => void>((code) => {
            exited?.(code);
        });
        const { disarm, handler } = registered("SIGINT", () => guardCleanup(cleanup, exit));

        disarms.push(disarm);

        handler();
        handler();
        // Every promise already settled has run its continuation by the time a macrotask does.
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect(exit).not.toHaveBeenCalled();

        finish();

        await expect(exitedWith).resolves.toBe(130);

        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
