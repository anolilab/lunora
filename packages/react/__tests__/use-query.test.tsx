import type { FunctionReference } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const DEFAULT_ARGS: Record<string, unknown> = {};
const SHARED_ARGS: Record<string, unknown> = { a: 1 };

const Display = ({ args = DEFAULT_ARGS }: { args?: Record<string, unknown> | "skip" }): ReactElement => {
    const data = useQuery(makeRef("posts:list"), args);

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery", () => {
    it("returns undefined initially, then the resolved value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
    });

    it('"skip" short-circuits the query — no client call', () => {
        expect.assertions(3);

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });

    it("two components sharing args share a single network call", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 2 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display args={SHARED_ARGS} />
                <Display args={SHARED_ARGS} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            const nodes = screen.getAllByTestId("display");

            expect(nodes).toHaveLength(2);

            for (const node of nodes) {
                expect(node.textContent).toBe(JSON.stringify({ count: 2 }));
            }
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(mock.subscribe).toHaveBeenCalledTimes(1);
    });

    it("wS deltas update the displayed value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => 0);

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("0");
        });

        await act(async () => {
            mock.emit("posts:list", 42);
        });

        // TanStack v5 schedules cache notifications on a microtask, so the
        // post-emit update lands on a later commit — waitFor lets it flush.
        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("42");
        });
    });
});
