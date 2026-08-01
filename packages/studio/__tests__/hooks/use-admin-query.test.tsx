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
});
