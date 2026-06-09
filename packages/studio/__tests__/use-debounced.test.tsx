import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import useDebounced from "../src/use-debounced";

const Probe = ({ delayMs, value }: { delayMs?: number; value: string }): React.ReactElement => {
    const debounced = useDebounced(value, delayMs);

    return <span data-testid="out">{debounced}</span>;
};

describe("useDebounced", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns the initial value immediately", () => {
        expect.assertions(1);

        render(<Probe delayMs={300} value="a" />);

        expect(screen.getByTestId("out").textContent).toBe("a");
    });

    it("updates only after the value has been stable for the delay", () => {
        expect.assertions(2);

        const { rerender } = render(<Probe delayMs={300} value="a" />);

        rerender(<Probe delayMs={300} value="ab" />);

        // Before the delay elapses, the debounced value still trails.
        expect(screen.getByTestId("out").textContent).toBe("a");

        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(screen.getByTestId("out").textContent).toBe("ab");
    });

    it("a burst of changes only settles on the last value", () => {
        expect.assertions(1);

        const { rerender } = render(<Probe delayMs={300} value="a" />);

        rerender(<Probe delayMs={300} value="ab" />);
        act(() => {
            vi.advanceTimersByTime(100);
        });
        rerender(<Probe delayMs={300} value="abc" />);
        act(() => {
            vi.advanceTimersByTime(100);
        });
        rerender(<Probe delayMs={300} value="abcd" />);
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(screen.getByTestId("out").textContent).toBe("abcd");
    });
});
