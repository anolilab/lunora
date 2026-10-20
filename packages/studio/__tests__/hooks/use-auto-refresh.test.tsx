import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoRefresh } from "../../src/hooks/use-auto-refresh";

const Harness = ({ enabled, intervalMs, onTick }: { enabled: boolean; intervalMs?: number; onTick: () => unknown }): ReactElement => {
    useAutoRefresh(onTick, enabled, intervalMs);

    return <div />;
};

describe("useAutoRefresh", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("ticks on the interval while enabled", () => {
        expect.assertions(1);

        const onTick = vi.fn<() => void>();

        render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        vi.advanceTimersByTime(3000);

        expect(onTick).toHaveBeenCalledTimes(3);
    });

    it("does not tick while disabled", () => {
        expect.assertions(1);

        const onTick = vi.fn<() => void>();

        render(<Harness enabled={false} intervalMs={1000} onTick={onTick} />);

        vi.advanceTimersByTime(5000);

        expect(onTick).not.toHaveBeenCalled();
    });

    it("stops ticking after unmount", () => {
        expect.assertions(1);

        const onTick = vi.fn<() => void>();

        const { unmount } = render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        vi.advanceTimersByTime(1000);
        unmount();
        vi.advanceTimersByTime(3000);

        expect(onTick).toHaveBeenCalledTimes(1);
    });

    it("skips ticks while the document is hidden", () => {
        expect.assertions(2);

        const onTick = vi.fn<() => void>();
        const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

        render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        vi.advanceTimersByTime(3000);

        expect(onTick).not.toHaveBeenCalled();

        // Becoming visible resumes ticking on the next interval.
        hiddenSpy.mockReturnValue(false);
        vi.advanceTimersByTime(1000);

        expect(onTick).toHaveBeenCalledTimes(1);
    });

    it("doubles the delay after each rejection and resets it after a success", async () => {
        expect.assertions(4);

        let fail = true;
        const onTick = vi.fn<() => Promise<void>>(async () => {
            if (fail) {
                throw new Error("boom");
            }
        });

        render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        // Fails at 1s, then waits 2s, fails again, then waits 4s.
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);

        expect(onTick).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(3999);

        expect(onTick).toHaveBeenCalledTimes(2);

        // The third tick succeeds, so the next one is back on the 1s interval.
        fail = false;
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(1000);

        expect(onTick).toHaveBeenCalledTimes(4);

        await vi.advanceTimersByTimeAsync(1000);

        expect(onTick).toHaveBeenCalledTimes(5);
    });

    it("waits for a thenable that is not a Promise before scheduling the next tick", async () => {
        expect.assertions(2);

        let settle: () => void = () => undefined;
        // A thenable on purpose: the hook must await one that is not a native Promise.
        const pending = {
            // eslint-disable-next-line unicorn/no-thenable -- the protocol method is the thing under test
            then(resolve: (value: unknown) => void): void {
                settle = () => {
                    resolve(undefined);
                };
            },
        };
        const onTick = vi.fn<() => unknown>(() => pending);

        render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(5000);

        expect(onTick).toHaveBeenCalledTimes(1);

        settle();
        await vi.advanceTimersByTimeAsync(1000);

        expect(onTick).toHaveBeenCalledTimes(2);
    });

    it("stops polling on UNAUTHORIZED until enabled toggles", async () => {
        expect.assertions(2);

        const onTick = vi.fn<() => Promise<void>>(() => Promise.reject(Object.assign(new Error("no session"), { code: "UNAUTHORIZED" })));

        const { rerender } = render(<Harness enabled intervalMs={1000} onTick={onTick} />);

        await vi.advanceTimersByTimeAsync(120_000);

        expect(onTick).toHaveBeenCalledTimes(1);

        rerender(<Harness enabled={false} intervalMs={1000} onTick={onTick} />);
        rerender(<Harness enabled intervalMs={1000} onTick={onTick} />);
        await vi.advanceTimersByTimeAsync(1000);

        expect(onTick).toHaveBeenCalledTimes(2);
    });
});
