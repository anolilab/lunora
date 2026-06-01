import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoRefresh } from "../src/use-auto-refresh.js";

function Harness({ enabled, intervalMs, onTick }: { enabled: boolean; intervalMs?: number; onTick: () => void }): ReactElement {
    useAutoRefresh(onTick, enabled, intervalMs);

    return <div />;
}

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
});
