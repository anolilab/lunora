import { LunoraProvider } from "@lunora/react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useAdminQuery } from "../../src/hooks/use-admin-query";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

/**
 * `useAdminQuery` is every studio panel's data path: the one-shot admin-RPC
 * read, the live WS bridge layered on top when `live: true`, and the
 * `liveError` suppression that keeps a stale rejection from lingering once the
 * live window isn't active. None of that had a direct test — every panel test
 * exercises it only incidentally through whichever panel happens to render.
 */
const wrapper =
    (mock: MockClientHooks) =>
    ({ children }: PropsWithChildren): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("useAdminQuery", () => {
    it("performs a one-shot fetch and resolves data", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });
        const { result } = renderHook(() => useAdminQuery<{ ok: boolean }>("listThings", {}), { wrapper: wrapper(mock) });

        expect(result.current.isLoading).toBe(true);
        expect(result.current.data).toBeUndefined();

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ ok: true });
        });

        expect(result.current.isLoading).toBe(false);
        expect(mock.query).toHaveBeenCalledTimes(1);
    });

    it("does not fetch or subscribe while enabled is false", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });
        const { result } = renderHook(() => useAdminQuery<{ ok: boolean }>("listThings", {}, { enabled: false, live: true }), {
            wrapper: wrapper(mock),
        });

        // Give any accidental async fetch a tick to have fired.
        await act(async () => {
            await Promise.resolve();
        });

        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(result.current.data).toBeUndefined();
        expect(result.current.isLoading).toBe(false);
    });

    it("re-derives the same cache key for an equal-but-new args object, without tearing down the live subscription", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });
        const { rerender } = renderHook(({ args }: { args: Record<string, unknown> }) => useAdminQuery("listThings", args, { live: true }), {
            initialProps: { args: { table: "orders" } },
            wrapper: wrapper(mock),
        });

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        // A fresh object, same shape/values — the effect keys on JSON.stringify,
        // so this must NOT close and reopen the subscription.
        rerender({ args: { table: "orders" } });
        rerender({ args: { table: "orders" } });

        expect(mock.subscribe).toHaveBeenCalledTimes(1);
    });

    it("closes and reopens the live subscription when the key actually changes", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });
        const { rerender } = renderHook(({ table }: { table: string }) => useAdminQuery("listThings", { table }, { live: true }), {
            initialProps: { table: "orders" },
            wrapper: wrapper(mock),
        });

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        rerender({ table: "invoices" });

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(2);
        });
    });

    it("counts one unsubscribe per resubscribe as the key changes across re-renders", async () => {
        expect.hasAssertions();

        const unsubscribed: number[] = [];
        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });
        let nextId = 0;

        // Wrap `subscribe` to observe the returned unsubscribe function being called.
        mock.subscribe.mockImplementation(() => {
            const id = nextId;

            nextId += 1;

            return () => {
                unsubscribed.push(id);
            };
        });

        const { rerender, unmount } = renderHook(({ table }: { table: string }) => useAdminQuery("listThings", { table }, { live: true }), {
            initialProps: { table: "orders" },
            wrapper: wrapper(mock),
        });

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        rerender({ table: "invoices" });

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(2);
        });

        expect(unsubscribed).toStrictEqual([0]);

        unmount();

        expect(unsubscribed).toStrictEqual([0, 1]);
    });

    it("pushes a live value straight into the cached data", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { count: 1 };
            },
        });
        const { result } = renderHook(() => useAdminQuery<{ count: number }>("counter", {}, { live: true }), { wrapper: wrapper(mock) });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ count: 1 });
        });

        act(() => {
            mock.emit("counter", { count: 2 });
        });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ count: 2 });
        });
    });

    it("surfaces a subscription rejection as liveError, while keeping the one-shot data visible", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { count: 1 };
            },
        });
        const { result } = renderHook(() => useAdminQuery<{ count: number }>("counter", {}, { live: true }), { wrapper: wrapper(mock) });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ count: 1 });
        });

        act(() => {
            mock.emitError("counter", "subscription rejected");
        });

        await waitFor(() => {
            expect(result.current.liveError).toBe("subscription rejected");
        });

        expect(result.current.data).toStrictEqual({ count: 1 });
    });

    it("suppresses a stale liveError once enabled flips to false, without unmounting", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: () => {
                return { count: 1 };
            },
        });
        const { rerender, result } = renderHook(
            ({ enabled }: { enabled: boolean }) => useAdminQuery<{ count: number }>("counter", {}, { enabled, live: true }),
            {
                initialProps: { enabled: true },
                wrapper: wrapper(mock),
            },
        );

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ count: 1 });
        });

        act(() => {
            mock.emitError("counter", "subscription rejected");
        });

        await waitFor(() => {
            expect(result.current.liveError).toBe("subscription rejected");
        });

        rerender({ enabled: false });

        await waitFor(() => {
            expect(result.current.liveError).toBeUndefined();
        });
    });

    it("a live push lands in the cache entry the read renders from", async () => {
        expect.hasAssertions();

        // Guards the seam in `clientScopedKey`: the read subscribes to the
        // client-scoped key while the subscription writes with
        // `queryClient.setQueryData`. Scope one and not the other and pushes land
        // in an entry nothing renders — live mode goes quiet with no error.
        const mock = createMockClient({
            query: () => {
                return { tick: 0 };
            },
        });
        const { result } = renderHook(() => useAdminQuery<{ tick: number }>("watchThing", {}, { live: true }), { wrapper: wrapper(mock) });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ tick: 0 });
        });

        act(() => {
            mock.emit("watchThing", { tick: 7 });
        });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ tick: 7 });
        });
    });

    it("does not serve a previous client's result after the admin token is swapped", async () => {
        expect.hasAssertions();

        // The studio shell rebuilds the LunoraClient on an admin-token change
        // WITHOUT remounting, and LunoraProvider keeps its QueryClient for the life
        // of the mount — so an unscoped key served the unauthorized client's result
        // forever. Reproducing that needs the provider to stay mounted while its
        // `client` prop changes, so the wrapper reads a mutable binding rather than
        // closing over one client (renderHook's `rerender` takes hook props, not
        // new render options, so the wrapper itself cannot be swapped).
        const stale = createMockClient({
            query: () => {
                return { rows: [] };
            },
        });

        Object.assign(stale.asClient, { clientIdentifier: () => "client-stale-token" });

        const fresh = createMockClient({
            query: () => {
                return { rows: ["now-authorized"] };
            },
        });

        Object.assign(fresh.asClient, { clientIdentifier: () => "client-valid-token" });

        let active = stale;
        const swapWrapper = ({ children }: PropsWithChildren): ReactElement => <LunoraProvider client={active.asClient}>{children}</LunoraProvider>;

        const { rerender, result } = renderHook(() => useAdminQuery<{ rows: string[] }>("listRows", {}), { wrapper: swapWrapper });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ rows: [] });
        });

        // The operator types a valid token: same mounted tree, new client instance.
        active = fresh;
        rerender();

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ rows: ["now-authorized"] });
        });
    });

    it("re-subscribes the live bridge onto the new client after the admin token is swapped", async () => {
        expect.hasAssertions();

        // Same swap as the test above, but for the LIVE leg. The subscription
        // effect closes over `client`, so a dependency list that omits it leaves
        // the bridge bound to the CLOSED client for the life of the mount: the
        // one-shot read re-fetches (its key carries `clientIdentifier()`) so the
        // panel fills in and looks fixed, while it has silently stopped streaming
        // and the old socket is never torn down.
        const staleUnsubscribes: string[] = [];
        const stale = createMockClient({
            query: () => {
                return { tick: 0 };
            },
        });

        Object.assign(stale.asClient, { clientIdentifier: () => "client-stale-token" });
        stale.subscribe.mockImplementation(() => () => {
            staleUnsubscribes.push("stale");
        });

        const fresh = createMockClient({
            query: () => {
                return { tick: 0 };
            },
        });

        Object.assign(fresh.asClient, { clientIdentifier: () => "client-valid-token" });

        let active = stale;
        const swapWrapper = ({ children }: PropsWithChildren): ReactElement => <LunoraProvider client={active.asClient}>{children}</LunoraProvider>;

        const { rerender, result } = renderHook(() => useAdminQuery<{ tick: number }>("watchTicks", {}, { live: true }), { wrapper: swapWrapper });

        await waitFor(() => {
            expect(stale.subscribe).toHaveBeenCalledTimes(1);
        });

        // The operator pastes the right token: same mounted tree, new client.
        active = fresh;
        rerender();

        await waitFor(() => {
            expect(fresh.subscribe).toHaveBeenCalledTimes(1);
        });

        // The dead client's socket is torn down, not leaked.
        expect(staleUnsubscribes).toStrictEqual(["stale"]);

        // And a push on the NEW client reaches the panel.
        act(() => {
            fresh.emit("watchTicks", { tick: 42 });
        });

        await waitFor(() => {
            expect(result.current.data).toStrictEqual({ tick: 42 });
        });
    });
});
