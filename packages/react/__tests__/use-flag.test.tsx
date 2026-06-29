import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useFlag, useFlags } from "../src/use-flag";
import { createMockClient } from "./mock-client";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

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
});
