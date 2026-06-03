import type { FunctionReference } from "@cirrus/client";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { cirrusQueryKey } from "../src/query-key.js";
import { createServerClient, fetchAction, fetchMutation, fetchQuery, prefetchQuery, preloadedQueryResult, preloadQuery } from "../src/server.js";
import useQuery from "../src/use-query.js";
import { createMockClient } from "./mock-client.js";

/** A typed query reference so `useQuery` infers args/return without casts. */
const queryRef = <Args extends Record<string, unknown>, Return>(path: string): FunctionReference<"query", Args, Return> => {
    return { __cirrusRef: path };
};

/** Minimal `fetch` double that returns one RPC `{ result }` envelope and records the request. */
const mockFetch = (result: unknown): ReturnType<typeof vi.fn> =>
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async () =>
            ({
                headers: { get: () => null },
                json: async () => {
                    return { result };
                },
                status: 200,
            }) as unknown as Response,
    );

describe("createServerClient", () => {
    it("runs a query over HTTP RPC against the configured url", async () => {
        expect.assertions(3);

        const fetchImpl = mockFetch({ count: 7 });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });

        const value = await client.query(queryRef<Record<string, never>, { count: number }>("posts:list"), {});

        expect(value).toStrictEqual({ count: 7 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url] = fetchImpl.mock.calls[0]!;

        expect(url).toBe("https://app.example.dev/_cirrus/rpc");
    });

    it("sends the bearer token as an Authorization header when provided", async () => {
        expect.assertions(2);

        const fetchImpl = mockFetch({ ok: true });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, token: "jwt-123", url: "https://app.example.dev" });

        await client.query(queryRef<Record<string, never>, { ok: boolean }>("posts:list"), {});

        const init = fetchImpl.mock.calls[0]![1] as RequestInit;
        const headers = init.headers as Record<string, string>;

        expect(headers["authorization"]).toBe("Bearer jwt-123");

        const body = JSON.parse(init.body as string) as { functionPath: string };

        expect(body.functionPath).toBe("posts:list");
    });
});

describe("prefetchQuery", () => {
    it("seeds the QueryClient under the same key the client hooks read", async () => {
        expect.assertions(1);

        const queryClient = new QueryClient();
        const fetchImpl = mockFetch([{ id: 1 }]);
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });
        const reference = queryRef<Record<string, never>, { id: number }[]>("posts:list");

        await prefetchQuery(queryClient, client, reference, {});

        // The value must be retrievable under cirrusQueryKey — proving the
        // server prefetch and the client `useQuery` agree on the key shape.
        expect(queryClient.getQueryData(cirrusQueryKey(reference, {}, undefined))).toStrictEqual([{ id: 1 }]);
    });

    it("hydrates a client useQuery with no loading flash and no client fetch", async () => {
        expect.hasAssertions();

        // A server-side client that produces the prefetched value.
        const queryClient = new QueryClient();
        const serverFetch = mockFetch({ title: "hello" });
        const serverClient = createServerClient({ fetch: serverFetch as unknown as typeof fetch, url: "https://app.example.dev" });
        const reference = queryRef<{ id: number }, { title: string }>("posts:get");

        await prefetchQuery(queryClient, serverClient, reference, { id: 1 });

        // The browser client never needs to fetch — the value is already cached.
        const browser = createMockClient(() => {
            return { title: "SHOULD-NOT-FETCH" };
        });

        const Post = (): ReactElement => {
            const data = useQuery(reference, { id: 1 });

            return <div data-testid="post">{data?.title ?? "loading"}</div>;
        };

        render(
            <CirrusProvider client={browser.asClient} queryClient={queryClient}>
                <Post />
            </CirrusProvider>,
        );

        // First paint already shows the hydrated value — no "loading" flash.
        expect(screen.getByTestId("post").textContent).toBe("hello");
        expect(browser.query).not.toHaveBeenCalled();

        // The live subscription still attaches so later server pushes update it.
        await waitFor(() => {
            expect(browser.subscribe).toHaveBeenCalledTimes(1);
        });
    });
});

describe("fetchQuery / fetchMutation / fetchAction", () => {
    it("fetchQuery runs a query and returns the result", async () => {
        expect.assertions(2);

        const fetchImpl = mockFetch({ count: 9 });

        const value = await fetchQuery(
            { fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" },
            queryRef<Record<string, never>, { count: number }>("posts:count"),
            {},
        );

        expect(value).toStrictEqual({ count: 9 });

        const [url] = fetchImpl.mock.calls[0]!;

        expect(url).toBe("https://app.example.dev/_cirrus/rpc");
    });

    it("fetchMutation forwards the bearer token and runs over HTTP RPC", async () => {
        expect.assertions(2);

        const fetchImpl = mockFetch({ id: "m1" });

        const value = await fetchMutation(
            { fetch: fetchImpl as unknown as typeof fetch, token: "jwt-9", url: "https://app.example.dev" },
            queryRef<{ title: string }, { id: string }>("posts:create"),
            { title: "hi" },
        );

        expect(value).toStrictEqual({ id: "m1" });

        const init = fetchImpl.mock.calls[0]![1] as RequestInit;
        const headers = init.headers as Record<string, string>;

        expect(headers["authorization"]).toBe("Bearer jwt-9");
    });

    it("fetchAction runs an action and returns the result", async () => {
        expect.assertions(1);

        const fetchImpl = mockFetch({ ok: true });

        const value = await fetchAction(
            { fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" },
            queryRef<Record<string, never>, { ok: boolean }>("posts:sync"),
            {},
        );

        expect(value).toStrictEqual({ ok: true });
    });
});

describe("preloadQuery (server re-export)", () => {
    it("captures a serializable Preloaded token and reads its value back", async () => {
        expect.assertions(3);

        const fetchImpl = mockFetch({ count: 3 });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });

        const token = await preloadQuery(client, queryRef<Record<string, never>, { count: number }>("posts:count"), {});

        expect(token.__cirrusPreloaded).toBe(true);
        expect(token.functionPath).toBe("posts:count");
        expect(preloadedQueryResult(token)).toStrictEqual({ count: 3 });
    });
});
