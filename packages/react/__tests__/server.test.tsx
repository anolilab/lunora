import type { FunctionReference } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { lunoraQueryKey } from "../src/query-key";
import { lunoraQueryOptions } from "../src/query-options";
import {
    createServerClient,
    deserializePreloaded,
    fetchAction,
    fetchMutation,
    fetchQuery,
    getServerSession,
    prefetchQuery,
    preloadedQueryResult,
    preloadQuery,
    serializePreloaded,
} from "../src/server";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

/** A typed query reference so `useQuery` infers args/return without casts. */
const queryRef = <Args extends Record<string, unknown>, Return>(path: string): FunctionReference<"query", Args, Return> => {
    return { __lunoraRef: path };
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
                ok: true,
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

        expect(url).toBe("https://app.example.dev/_lunora/rpc");
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

        // The value must be retrievable under lunoraQueryKey — proving the
        // server prefetch and the client `useQuery` agree on the key shape.
        expect(queryClient.getQueryData(lunoraQueryKey(reference, {}, undefined))).toStrictEqual([{ id: 1 }]);
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
            <LunoraProvider client={browser.asClient} queryClient={queryClient}>
                <Post />
            </LunoraProvider>,
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

        expect(url).toBe("https://app.example.dev/_lunora/rpc");
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

describe("lunoraQueryOptions", () => {
    it("builds queryFn/queryKey keyed identically to the first-class hooks", async () => {
        expect.assertions(3);

        const fetchImpl = mockFetch({ count: 5 });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });
        const reference = queryRef<Record<string, never>, { count: number }>("posts:count");

        const options = lunoraQueryOptions(client, reference, {});

        // The key must match what useQuery / prefetchQuery use, so the adapter
        // shares cache identity with the first-class hooks.
        expect(options.queryKey).toStrictEqual(lunoraQueryKey(reference, {}, undefined));
        expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);

        const value = await options.queryFn();

        expect(value).toStrictEqual({ count: 5 });
    });

    it("threads shardKey into both the key and the call", async () => {
        expect.assertions(2);

        const fetchImpl = mockFetch({ ok: true });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });
        const reference = queryRef<Record<string, never>, { ok: boolean }>("rooms:get");

        const options = lunoraQueryOptions(client, reference, {}, { shardKey: "room-7" });

        expect(options.queryKey).toStrictEqual(lunoraQueryKey(reference, {}, "room-7"));

        await options.queryFn();

        const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { shardKey?: string };

        expect(body.shardKey).toBe("room-7");
    });
});

describe("preloadQuery (server re-export)", () => {
    it("captures a serializable Preloaded token and reads its value back", async () => {
        expect.assertions(3);

        const fetchImpl = mockFetch({ count: 3 });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });

        const token = await preloadQuery(client, queryRef<Record<string, never>, { count: number }>("posts:count"), {});

        expect(token.__lunoraPreloaded).toBe(true);
        expect(token.functionPath).toBe("posts:count");
        expect(preloadedQueryResult(token)).toStrictEqual({ count: 3 });
    });
});

describe("@lunora/client/ssr re-exports (one server entry)", () => {
    it("createServerClient is sourced from @lunora/client/ssr and runs RPC against the url", async () => {
        expect.assertions(2);

        const fetchImpl = mockFetch({ count: 11 });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });

        const value = await client.query(queryRef<Record<string, never>, { count: number }>("posts:count"), {});

        expect(value).toStrictEqual({ count: 11 });

        const [url] = fetchImpl.mock.calls[0]!;

        expect(url).toBe("https://app.example.dev/_lunora/rpc");
    });

    it("getServerSession resolves the session from the request headers via auth.api.getSession", async () => {
        expect.assertions(2);

        const session = { session: { id: "s1" }, user: { id: "u1" } };
        // The forwarded request's cookie reaches better-auth unchanged.
        const getSession = vi.fn<(input: { headers: Headers }) => Promise<typeof session | null>>(async ({ headers }) =>
            headers.get("cookie") === "sid=abc" ? session : null,
        );
        const auth = { api: { getSession } };

        const request = new Request("https://app.example.dev", { headers: { cookie: "sid=abc" } });
        const resolved = await getServerSession(request, auth);

        expect(resolved).toStrictEqual(session);
        expect(getSession).toHaveBeenCalledTimes(1);
    });

    it("serializePreloaded / deserializePreloaded round-trip a Preloaded token (script-safe)", () => {
        expect.assertions(2);

        const token = { __lunoraPreloaded: true as const, args: {}, functionPath: "posts:list", value: { html: "<b>x</b>" } };
        const serialized = serializePreloaded(token);

        // The `<` is escaped so the payload is safe to inline in a <script> tag.
        expect(serialized).not.toContain("<");
        expect(deserializePreloaded(serialized)).toStrictEqual(token);
    });
});
