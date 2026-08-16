import type { FunctionReference } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useAction } from "../src/use-action";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

/** A promise plus its resolver, so a test can hold a call open and settle it deliberately. */
const deferred = (): { promise: Promise<unknown>; resolve: (value: unknown) => void } => {
    let settle: (value: unknown) => void = (_value) => undefined;
    const promise = new Promise<unknown>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

interface HarnessProps {
    onCall: (call: () => Promise<unknown>) => void;
    options?: { shardKey?: string };
}

const Harness = ({ onCall, options }: HarnessProps): ReactElement => {
    const { call, error, isError, pending } = useAction(makeRef("commands:run"));

    onCall(() => call({ command: "lunora" }, options));

    return (
        <>
            <div data-testid="pending">{pending ? "yes" : "no"}</div>
            <div data-testid="error">{isError ? (error?.message ?? "error") : "none"}</div>
        </>
    );
};

describe("useAction", () => {
    it("invokes client.action and flips `pending` while in-flight", async () => {
        expect.hasAssertions();

        const first = deferred();
        const mock = createMockClient();

        mock.action.mockReturnValue(first.promise);

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onCall={(call) => {
                        trigger = call;
                    }}
                />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("pending").textContent).toBe("no");

        let resolved: unknown;
        let inFlight: Promise<unknown> | undefined;

        act(() => {
            inFlight = trigger().then((value) => {
                resolved = value;

                return value;
            });
        });

        await waitFor(() => {
            expect(screen.getByTestId("pending").textContent).toBe("yes");
        });

        await act(async () => {
            first.resolve({ code: 0 });
            await inFlight;
        });

        expect(resolved).toEqual({ code: 0 });
        expect(mock.action).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "commands:run" }), { command: "lunora" }, undefined);
        expect(screen.getByTestId("pending").textContent).toBe("no");
    });

    it("forwards a per-call shardKey to the client", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockResolvedValue({ code: 0 });

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; see above.
                    onCall={(call) => {
                        trigger = call;
                    }}
                    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- one-shot render; a memoised object adds nothing here.
                    options={{ shardKey: "project-1" }}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            await trigger();
        });

        expect(mock.action).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: "commands:run" }), { command: "lunora" }, { shardKey: "project-1" });
    });

    it("rejects and surfaces the error rather than swallowing it", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.action.mockRejectedValue(new Error("command refused"));

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; see above.
                    onCall={(call) => {
                        trigger = call;
                    }}
                />
            </LunoraProvider>,
        );

        // The awaitable must reject — a caller that awaits `call()` has to be able
        // to branch on failure, which is why this maps to `mutateAsync` rather
        // than TanStack's fire-and-forget `mutate`.
        await act(async () => {
            await expect(trigger()).rejects.toThrow("command refused");
        });

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("command refused");
        });

        // And `pending` clears on the failure path, not just the success path.
        expect(screen.getByTestId("pending").textContent).toBe("no");
    });

    it("keeps `pending` true until the last of several overlapping calls settles", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const calls = [deferred(), deferred()];

        // `mockReturnValueOnce` twice rather than a `mockImplementation` callback:
        // the mock is typed `vi.fn()` (void-returning), so handing it a
        // promise-returning implementation trips `no-misused-promises`.
        mock.action.mockReturnValueOnce(calls[0]?.promise).mockReturnValueOnce(calls[1]?.promise);

        let trigger: () => Promise<unknown> = async () => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; see above.
                    onCall={(call) => {
                        trigger = call;
                    }}
                />
            </LunoraProvider>,
        );

        let both: Promise<unknown> | undefined;

        act(() => {
            both = Promise.all([trigger(), trigger()]);
        });

        await waitFor(() => {
            expect(mock.action).toHaveBeenCalledTimes(2);
        });

        // Settling only the first must NOT clear `pending` — this is the
        // ref-counting, and getting it wrong makes a spinner vanish while a
        // second call is still running.
        await act(async () => {
            calls[0]?.resolve({ code: 0 });
        });

        expect(screen.getByTestId("pending").textContent).toBe("yes");

        await act(async () => {
            calls[1]?.resolve({ code: 0 });
            await both;
        });

        await waitFor(() => {
            expect(screen.getByTestId("pending").textContent).toBe("no");
        });
    });
});
