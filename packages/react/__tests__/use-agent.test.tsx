import type { FunctionReference, SubscriptionErrorCallback } from "@lunora/client";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseAgentApi, UseAgentOptions, UseAgentResult } from "../src/use-agent";
import { useAgent } from "../src/use-agent";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const THREAD_REF = "agents:agentThread";
const RUN_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

const buildOptions = (overrides: Partial<UseAgentOptions> = {}): UseAgentOptions => {
    const api = {
        agents: {
            agentThread: makeRef(THREAD_REF),
        },
    } as unknown as UseAgentApi;

    return {
        api,
        cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
        run: makeRef(RUN_REF) as FunctionReference<"mutation">,
        threadKey: "t1",
        ...overrides,
    };
};

interface HarnessProps {
    onReady: (result: UseAgentResult) => void;
    options: UseAgentOptions;
}

const Harness = ({ onReady, options }: HarnessProps): ReactElement => {
    const result = useAgent(options);

    // Expose the latest committed result to the test from an effect — invoking a
    // prop callback during render is impure (React may replay/discard renders).
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-data-to-parent -- test harness: the hook must run inside a component, so the effect is the only channel to surface its result to the test.
        onReady(result);
    });

    return <span>{result.status ?? ""}</span>;
};

describe("useAgent", () => {
    it("surfaces a thread-subscription error on `error` and through `onError`", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onError = vi.fn<SubscriptionErrorCallback>();
        let latest: undefined | UseAgentResult;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback capturing the hook's latest committed result.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions({ onError })}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            mock.emitError(THREAD_REF, { code: "UNAUTHORIZED", message: "session expired" });
        });

        await waitFor(() => {
            expect(latest?.error).toBeDefined();
        });

        // Without this the thread just freezes at its last status.
        expect(latest?.error).toMatchObject({ code: "UNAUTHORIZED", message: "session expired" });
        expect(onError).toHaveBeenCalledWith({ code: "UNAUTHORIZED", message: "session expired" });
    });

    it("fires the run mutation with the input, thread key, and merged run args", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions({ runArgs: { owner: "u_1" } })}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            await latest?.run("hello", { title: "greeting" });
        });

        // `{ input, threadKey }` merged over `runArgs` and the per-call args.
        expect(mock.mutation).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: RUN_REF }),
            { input: "hello", owner: "u_1", threadKey: "t1", title: "greeting" },
            undefined,
        );
    });

    it("reflects the in-flight run through `pending`", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // The mutation stays pending until `release()` so we can observe `pending`
        // flip true mid-flight, then settle false once the run resolves.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the mock's default signature is void-returning; a deferred promise is exactly the intent here.
        mock.mutation.mockImplementation(() => gate);

        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        expect(latest?.pending).toBe(false);

        let pending: Promise<void> | undefined;

        await act(async () => {
            pending = latest?.run("hi");
        });

        await waitFor(() => {
            expect(latest?.pending).toBe(true);
        });

        await act(async () => {
            release?.();
            await pending;
        });

        expect(latest?.pending).toBe(false);
    });

    it("flows live status through from the agentThread subscription", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        expect(latest?.status).toBeUndefined();

        await act(async () => {
            mock.emit(THREAD_REF, { instanceId: "wf-1", status: "running" });
        });

        expect(latest?.status).toBe("running");
        expect(latest?.thread).toStrictEqual({ instanceId: "wf-1", status: "running" });
    });

    it("cancel is a no-op when no run is in flight", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            await latest?.cancel();
        });

        // No thread/instanceId yet → nothing to terminate, no mutation dispatched.
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("cancel terminates the in-flight run with the instanceId and thread key", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            mock.emit(THREAD_REF, { instanceId: "wf-1", status: "running" });
        });

        await act(async () => {
            await latest?.cancel();
        });

        expect(mock.mutation).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);
    });

    it("cancel is a no-op when no cancel mutation was supplied", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions({ cancel: undefined })}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            mock.emit(THREAD_REF, { instanceId: "wf-1", status: "running" });
        });

        await act(async () => {
            await latest?.cancel();
        });

        expect(mock.mutation).not.toHaveBeenCalled();
    });
});
