import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useFlag, useFlags } from "../src/use-flag";
import { createMockClient } from "./mock-client";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

/**
 * Records every COMMITTED value of a single flag (via a layout effect). A stale
 * render-phase value that React discards never commits, so the recorded list is
 * exactly what painted — letting a test prove the previous flag's value never
 * flashed under a new key.
 */
const FlagCommitRecorder = ({ flagKey, onCommit }: { flagKey: string; onCommit: (value: string) => void }): ReactElement => {
    const value = useFlag(flagKey, "control");

    // No dep array on purpose — record the value of EVERY commit so a test can
    // assert the previous flag's value never actually painted under a new key.
    useLayoutEffect(() => {
        onCommit(value);
    });

    return <div data-testid="flag">{value}</div>;
};

/** Same as {@link FlagCommitRecorder} but for the batched `useFlags` — records each committed record as JSON. */
const FlagsCommitRecorder = ({ flags, onCommit }: { flags: Record<string, unknown>; onCommit: (value: string) => void }): ReactElement => {
    const values = useFlags(flags as Parameters<typeof useFlags>[0]);

    // No dep array on purpose — record the committed record shape of every commit.
    useLayoutEffect(() => {
        onCommit(JSON.stringify(values));
    });

    return <div data-testid="flags">{JSON.stringify(values)}</div>;
};

const FlagView = ({ flagKey = "dark-mode" }: { flagKey?: string }): ReactElement => {
    const enabled = useFlag(flagKey, false);

    return <div data-testid="flag">{String(enabled)}</div>;
};

const StringFlagView = (): ReactElement => {
    const hero = useFlag("hero", "control");

    return <div data-testid="flag">{hero}</div>;
};

const FlagsView = (): ReactElement => {
    const flags = useFlags({ "dark-mode": false, "page-size": 10 });

    return <div data-testid="flags">{JSON.stringify(flags)}</div>;
};

describe("useFlag", () => {
    it("subscribes on the reserved flags channel — no HTTP fetch — and renders the default until a value lands", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <FlagView />
            </LunoraProvider>,
        );

        // A reserved flag path is not a registered function — it must never HTTP-fetch.
        expect(mock.query).not.toHaveBeenCalled();

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(screen.getByTestId("flag").textContent).toBe("false");

        await act(async () => {
            mock.emit(FLAGS_REF, true);
        });

        expect(screen.getByTestId("flag").textContent).toBe("true");
    });

    it("sends the flag key, inferred type, and default as subscribe args", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <StringFlagView />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        const [reference, args] = mock.subscribe.mock.calls[0] as [{ __lunoraRef: string }, Record<string, unknown>];

        expect(reference.__lunoraRef).toBe(FLAGS_REF);
        expect(args).toStrictEqual({ context: undefined, default: "control", key: "hero", type: "string" });

        await act(async () => {
            mock.emit(FLAGS_REF, "variant-b");
        });

        expect(screen.getByTestId("flag").textContent).toBe("variant-b");
    });

    it("re-subscribes and resets to the default when the key changes", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <FlagView flagKey="alpha" />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            mock.emit(FLAGS_REF, true);
        });

        expect(screen.getByTestId("flag").textContent).toBe("true");

        // A different key is a different flag — the prior `true` must not leak.
        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <FlagView flagKey="beta" />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(2);
        });

        expect(screen.getByTestId("flag").textContent).toBe("false");
    });

    it("never paints the previous flag's resolved value for a frame when the key changes", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const commits: string[] = [];

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <FlagCommitRecorder
                    flagKey="hero-a"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness: capture each committed flag value.
                    onCommit={(value) => commits.push(value)}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            mock.emit(FLAGS_REF, "variant");
        });

        expect(screen.getByTestId("flag").textContent).toBe("variant");

        // Switch to a different experiment. The reset-to-default must happen
        // DURING render, so "variant" (hero-a's arm) never commits under
        // "hero-b" — otherwise the wrong arm flashes for one painted frame.
        commits.length = 0;
        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <FlagCommitRecorder
                    flagKey="hero-b"
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness: capture each committed flag value.
                    onCommit={(value) => commits.push(value)}
                />
            </LunoraProvider>,
        );

        expect(commits).not.toContain("variant");
        expect(commits[0]).toBe("control");
    });

    it("fails open — a thrown subscribe keeps the default", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.subscribe.mockImplementationOnce(() => {
            throw new Error("socket closed");
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <FlagView />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(screen.getByTestId("flag").textContent).toBe("false");
    });
});

describe("useFlags", () => {
    it("opens one subscription per key and resolves each independently", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <FlagsView />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(2);
        });

        expect(screen.getByTestId("flags").textContent).toBe(JSON.stringify({ "dark-mode": false, "page-size": 10 }));

        // Fan distinct values to each per-key subscription via its subscribe-time args.
        await act(async () => {
            mock.emit(FLAGS_REF, true, (args) => (args as { key: string }).key === "dark-mode");
            mock.emit(FLAGS_REF, 50, (args) => (args as { key: string }).key === "page-size");
        });

        expect(screen.getByTestId("flags").textContent).toBe(JSON.stringify({ "dark-mode": true, "page-size": 50 }));
    });

    it("never commits a record shaped like the previous flag set when the set changes", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const commits: string[] = [];
        // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- test harness fixture passed as a prop
        const initialFlags: Record<string, unknown> = { a: false };
        // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- test harness fixture passed as a prop
        const nextFlags: Record<string, unknown> = { b: 0 };

        const view = render(
            <LunoraProvider client={mock.asClient}>
                <FlagsCommitRecorder
                    flags={initialFlags}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness: capture each committed flag record.
                    onCommit={(value) => commits.push(value)}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            mock.emit(FLAGS_REF, true, (args) => (args as { key: string }).key === "a");
        });

        expect(screen.getByTestId("flags").textContent).toBe(JSON.stringify({ a: true }));

        // Swap to a differently-shaped set. The committed record must switch
        // straight to `{ b: 0 }` — never the stale `{ a: true }` (missing the new
        // `b` key, carrying the old `a`), which would violate the declared type.
        commits.length = 0;
        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <FlagsCommitRecorder
                    flags={nextFlags}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness: capture each committed flag record.
                    onCommit={(value) => commits.push(value)}
                />
            </LunoraProvider>,
        );

        expect(commits.some((entry) => entry.includes('"a"'))).toBe(false);
        expect(commits[0]).toBe(JSON.stringify({ b: 0 }));
    });
});
