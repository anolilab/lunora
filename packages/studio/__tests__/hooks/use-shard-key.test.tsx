import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useShardKey } from "../../src/hooks/use-shard-key";

const Probe = ({
    delayMs,
    initial,
    onReady,
}: {
    delayMs?: number;
    initial: string | undefined;
    onReady: (setShardKey: (value: string) => void) => void;
}): React.ReactElement => {
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initial, delayMs);

    onReady(setShardKey);

    return (
        <div>
            <span data-testid="raw">{shardKey}</span>
            <span data-testid="query">{queryShardKey}</span>
        </div>
    );
};

describe("useShardKey", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("seeds both shardKey and queryShardKey from initial immediately", () => {
        expect.assertions(2);

        render(<Probe initial="alpha" onReady={() => {}} />);

        expect(screen.getByTestId("raw").textContent).toBe("alpha");
        expect(screen.getByTestId("query").textContent).toBe("alpha");
    });

    it("defaults to the empty string when initial is undefined", () => {
        expect.assertions(2);

        render(<Probe initial={undefined} onReady={() => {}} />);

        expect(screen.getByTestId("raw").textContent).toBe("");
        expect(screen.getByTestId("query").textContent).toBe("");
    });

    it("debounces setShardKey edits: queryShardKey trails until delayMs elapses", () => {
        expect.assertions(2);

        let setShardKey: ((value: string) => void) | undefined;

        render(
            <Probe
                delayMs={400}
                initial=""
                onReady={(set) => {
                    setShardKey = set;
                }}
            />,
        );

        act(() => {
            setShardKey?.("tenant-1");
        });

        expect(screen.getByTestId("query").textContent).toBe("");

        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(screen.getByTestId("query").textContent).toBe("tenant-1");
    });

    it("a burst of edits only settles queryShardKey on the last value", () => {
        expect.assertions(1);

        let setShardKey: ((value: string) => void) | undefined;

        render(
            <Probe
                delayMs={400}
                initial=""
                onReady={(set) => {
                    setShardKey = set;
                }}
            />,
        );

        act(() => {
            setShardKey?.("t");
        });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        act(() => {
            setShardKey?.("te");
        });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        act(() => {
            setShardKey?.("ten");
        });
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(screen.getByTestId("query").textContent).toBe("ten");
    });

    it("trims whitespace into queryShardKey", () => {
        expect.assertions(1);

        let setShardKey: ((value: string) => void) | undefined;

        render(
            <Probe
                delayMs={400}
                initial=""
                onReady={(set) => {
                    setShardKey = set;
                }}
            />,
        );

        act(() => {
            setShardKey?.("  padded  ");
        });
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(screen.getByTestId("query").textContent).toBe("padded");
    });

    it("resets queryShardKey synchronously (no debounce wait) when initial changes", () => {
        expect.assertions(4);

        let setShardKey: ((value: string) => void) | undefined;
        const onReady = (set: (value: string) => void): void => {
            setShardKey = set;
        };

        const { rerender } = render(<Probe delayMs={400} initial="shard-a" onReady={onReady} />);

        act(() => {
            setShardKey?.("still-typing-shard-a-edit");
        });

        // Mid-debounce: the raw input reflects the edit, the settled query value
        // still trails the last COMMITTED shard.
        expect(screen.getByTestId("raw").textContent).toBe("still-typing-shard-a-edit");
        expect(screen.getByTestId("query").textContent).toBe("shard-a");

        // A caller-driven reset (e.g. a table switch) — new `initial` — must land
        // on BOTH raw and query state immediately, without waiting `delayMs`,
        // discarding the in-flight edit above rather than letting its pending
        // timer resolve into the new shard's `queryShardKey` later.
        rerender(<Probe delayMs={400} initial="shard-b" onReady={onReady} />);

        expect(screen.getByTestId("raw").textContent).toBe("shard-b");
        expect(screen.getByTestId("query").textContent).toBe("shard-b");
    });

    it("a stale pending debounce from before a reset cannot overwrite the reset", () => {
        expect.assertions(1);

        let setShardKey: ((value: string) => void) | undefined;
        const onReady = (set: (value: string) => void): void => {
            setShardKey = set;
        };

        const { rerender } = render(<Probe delayMs={400} initial="shard-a" onReady={onReady} />);

        act(() => {
            setShardKey?.("shard-a-typo");
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });

        rerender(<Probe delayMs={400} initial="shard-b" onReady={onReady} />);

        // Let the pre-reset timer's original deadline pass.
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(screen.getByTestId("query").textContent).toBe("shard-b");
    });
});
