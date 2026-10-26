import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { serializeQueryKey } from "../src/cache";
import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";

vi.mock(import("../src/cache"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, serializeQueryKey: vi.fn<typeof actual.serializeQueryKey>(actual.serializeQueryKey) };
});

const page = { continueCursor: null, isDone: true, page: ["a"] };

const client = {
    getAuthToken: vi.fn<() => string | null>(() => null),
    onAuthTokenChange: vi.fn<() => Unsubscribe>(() => () => undefined),
    onIdentityChange: vi.fn<() => Unsubscribe>(() => () => undefined),
    query: vi.fn<() => Promise<unknown>>(async () => page),
    subscribe: vi.fn<(reference: FunctionReference, args: unknown, callback: (value: unknown) => void) => Unsubscribe>((_reference, _args, callback) => {
        callback(page);

        return () => undefined;
    }),
} as unknown as LunoraClient;

const Feed = (): ReactElement => {
    const { results } = usePaginatedQuery({ __lunoraRef: "items:list" }, {}, { initialNumItems: 1 });

    return <span data-testid="results">{(results as string[]).join(",")}</span>;
};

describe("usePaginatedCore — cache events for other queries", () => {
    it("does not canonicalise the key of another function's update", async () => {
        expect.hasAssertions();

        const queryClient = new QueryClient();

        render(
            <LunoraProvider client={client} queryClient={queryClient}>
                <Feed />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a");
        });

        const serialize = vi.mocked(serializeQueryKey);

        serialize.mockClear();

        act(() => {
            for (let index = 0; index < 100; index += 1) {
                queryClient.setQueryData(["lunora", "other:get", `{"id":${String(index)}}`, null], index);
            }
        });

        expect(serialize).not.toHaveBeenCalled();
    });
});
