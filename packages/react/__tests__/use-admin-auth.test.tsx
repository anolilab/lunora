import type { AuthImpersonation, AuthPage, AuthSession, AuthUser, LunoraClient } from "@lunora/client";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useAuthSessions, useAuthUsers, useImpersonate, useOrganizations } from "../src/use-admin-auth";

/**
 * A minimal fake covering only the auth-admin surface these hooks touch, plus
 * the live/batch-transport methods (`query`/`mutation`/`subscribe`) as
 * `vi.fn()`s asserted NOT called — the whole point of these hooks is that
 * they route through the admin-gated HTTP methods (`adminFetch` on the real
 * client), never the WS/batch transport `@lunora/react`'s `useQuery`/
 * `useMutation` use.
 */
interface AdminAuthFakeClient {
    asClient: LunoraClient;
    deleteAuthOrganization: ReturnType<typeof vi.fn<(input: { organizationId: string }) => Promise<void>>>;
    getAuthToken: ReturnType<typeof vi.fn<() => null | string>>;
    impersonateAuthUser: ReturnType<typeof vi.fn<(input: { userId: string }) => Promise<AuthImpersonation>>>;
    listAuthOrganizations: ReturnType<typeof vi.fn<(options: { limit?: number }) => Promise<AuthPage<Record<string, unknown>>>>>;
    listAuthSessions: ReturnType<typeof vi.fn<(options: { limit?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>>;
    listAuthUsers: ReturnType<typeof vi.fn<(options: Record<string, unknown>) => Promise<AuthPage<AuthUser>>>>;
    mutation: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    onAuthTokenChange: ReturnType<typeof vi.fn<(listener: (token: null | string) => void) => () => void>>;
    query: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    setAuthToken: ReturnType<typeof vi.fn<(token: null | string) => void>>;
    subscribe: ReturnType<typeof vi.fn<() => () => void>>;
}

const createAdminAuthFakeClient = (): AdminAuthFakeClient => {
    const listAuthUsers = vi.fn<(options: Record<string, unknown>) => Promise<AuthPage<AuthUser>>>();
    const listAuthOrganizations = vi.fn<(options: { limit?: number }) => Promise<AuthPage<Record<string, unknown>>>>();
    const listAuthSessions = vi.fn<(options: { limit?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>();
    const impersonateAuthUser = vi.fn<(input: { userId: string }) => Promise<AuthImpersonation>>();
    const deleteAuthOrganization = vi.fn<(input: { organizationId: string }) => Promise<void>>();
    // Real-enough auth-token plumbing (not just a spy) so tests can exercise a
    // `setAuthToken` swap and observe `useAdminAuthList`'s `useSyncExternalStore`
    // subscription pick it up, mirroring `LunoraClient`'s real
    // `authToken`/`authTokenListeners` pair.
    let currentToken: null | string = null;
    const tokenListeners = new Set<(token: null | string) => void>();
    const getAuthToken = vi.fn<() => null | string>(() => currentToken);
    const onAuthTokenChange = vi.fn<(listener: (token: null | string) => void) => () => void>((listener) => {
        tokenListeners.add(listener);

        return () => tokenListeners.delete(listener);
    });
    const setAuthToken = vi.fn<(token: null | string) => void>((token) => {
        currentToken = token;

        for (const listener of tokenListeners) {
            listener(token);
        }
    });
    // Never called by these hooks — asserted against directly in a few tests
    // to prove the admin-gated HTTP path is used instead of the live/batch one.
    const query = vi.fn<() => Promise<unknown>>();
    const mutation = vi.fn<() => Promise<unknown>>();
    const subscribe = vi.fn<() => () => void>();

    const asClient = {
        deleteAuthOrganization,
        getAuthToken,
        impersonateAuthUser,
        listAuthOrganizations,
        listAuthSessions,
        listAuthUsers,
        mutation,
        onAuthTokenChange,
        query,
        setAuthToken,
        subscribe,
    } as unknown as LunoraClient;

    return {
        asClient,
        deleteAuthOrganization,
        getAuthToken,
        impersonateAuthUser,
        listAuthOrganizations,
        listAuthSessions,
        listAuthUsers,
        mutation,
        onAuthTokenChange,
        query,
        setAuthToken,
        subscribe,
    };
};

const wrapper =
    (client: LunoraClient) =>
    ({ children }: PropsWithChildren): ReactElement => <LunoraProvider client={client}>{children}</LunoraProvider>;

const user = (id: string): AuthUser => {
    return { email: `${id}@example.com`, id, name: id };
};
const session = (id: string, userId: string): AuthSession => {
    return { expiresAt: Date.now() + 60_000, id, userId };
};

describe("useAuthUsers", () => {
    it("loads rows via client.listAuthUsers, never the live/batch transport", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthUsers.mockResolvedValue({ rows: [user("u1"), user("u2")], total: 2 });

        const { result } = renderHook(() => useAuthUsers(), { wrapper: wrapper(fake.asClient) });

        expect(result.current.loading).toBe(true);
        expect(result.current.data).toBeUndefined();

        await waitFor(() => {
            expect(result.current.data).toHaveLength(2);
        });

        expect(result.current.data?.[0]?.id).toBe("u1");
        expect(result.current.total).toBe(2);
        expect(result.current.hasMore).toBe(false);
        expect(result.current.error).toBeUndefined();
        expect(result.current.loading).toBe(false);

        // Called through the admin-gated HTTP method, not the WS/batch RPC surface.
        expect(fake.listAuthUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
        expect(fake.query).not.toHaveBeenCalled();
        expect(fake.mutation).not.toHaveBeenCalled();
        expect(fake.subscribe).not.toHaveBeenCalled();
    });

    it("surfaces a rejected read as `error`", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthUsers.mockRejectedValue(new Error("admin token missing"));

        const { result } = renderHook(() => useAuthUsers(), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.error).toBeInstanceOf(Error);
        });

        expect(result.current.error?.message).toBe("admin token missing");
        expect(result.current.data).toBeUndefined();
        expect(result.current.loading).toBe(false);
    });
});

describe("useAuthSessions", () => {
    it("loadMore grows the requested window and re-fetches with a larger limit", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();
        const all = [session("s1", "u1"), session("s2", "u1"), session("s3", "u2")];

        fake.listAuthSessions.mockImplementation((options) =>
            Promise.resolve({
                rows: all.slice(0, options.limit ?? all.length),
                total: all.length,
            }),
        );

        const { result } = renderHook(() => useAuthSessions({ pageSize: 2 }), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(2);
        });

        expect(result.current.hasMore).toBe(true);
        expect(fake.listAuthSessions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2 }));

        result.current.loadMore();

        await waitFor(() => {
            expect(result.current.data).toHaveLength(3);
        });

        expect(fake.listAuthSessions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 4 }));
        expect(result.current.hasMore).toBe(false);
    });

    it("keeps prior rows visible (never blanks to undefined/loading) across a loadMore transition", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();
        const all = [session("s1", "u1"), session("s2", "u1"), session("s3", "u2")];

        // A resolver gate on the SECOND call lets the test observe the hook's
        // state while the larger-window fetch is still in flight, which is
        // exactly the window that used to blank the list (a brand-new
        // `queryKey` per `limit`, no `placeholderData`, `staleTime: 0` ⇒
        // TanStack v5 reports `status: 'pending'` until it resolves).
        let resolveSecondFetch: ((page: { rows: AuthSession[]; total: number }) => void) | undefined;
        let callCount = 0;

        fake.listAuthSessions.mockImplementation((options) => {
            callCount += 1;

            if (callCount === 1) {
                return Promise.resolve({ rows: all.slice(0, options.limit ?? all.length), total: all.length });
            }

            return new Promise((resolve) => {
                resolveSecondFetch = resolve;
            });
        });

        const { result } = renderHook(() => useAuthSessions({ pageSize: 2 }), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(2);
        });

        const firstWindow = result.current.data;

        result.current.loadMore();

        // The larger-window fetch is now in flight (`resolveSecondFetch` is
        // set once its promise executor runs). While it's pending, `data`
        // must stay defined — equal to the prior window — and `loading` must
        // stay `false`; neither may flash to `undefined`/`true`.
        await waitFor(() => {
            expect(resolveSecondFetch).toBeDefined();
        });

        expect(result.current.data).toBeDefined();
        expect(result.current.data).toStrictEqual(firstWindow);
        expect(result.current.loading).toBe(false);

        resolveSecondFetch?.({ rows: all, total: all.length });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(3);
        });

        expect(result.current.data).toBeDefined();
    });

    it("loadMore is a no-op once `hasMore` is false", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthSessions.mockResolvedValue({ rows: [session("s1", "u1")], total: 1 });

        const { result } = renderHook(() => useAuthSessions({ pageSize: 50 }), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(1);
        });

        expect(result.current.hasMore).toBe(false);

        const callsBefore = fake.listAuthSessions.mock.calls.length;

        result.current.loadMore();
        result.current.loadMore();

        // Give any (incorrect) refetch a tick to fire before asserting it didn't.
        await Promise.resolve();

        expect(fake.listAuthSessions).toHaveBeenCalledTimes(callsBefore);
        expect(result.current.data).toHaveLength(1);
    });

    it("scopes the read to one user via `userId`", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthSessions.mockResolvedValue({ rows: [session("s1", "u1")], total: 1 });

        const { result } = renderHook(() => useAuthSessions({ userId: "u1" }), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(1);
        });

        expect(fake.listAuthSessions).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
    });
});

describe("useOrganizations", () => {
    it("refetch() re-runs the read after an external mutation (mirrors Studio's onDone={refetchOrgs})", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthOrganizations
            .mockResolvedValueOnce({
                rows: [
                    { id: "org1", name: "Acme" },
                    { id: "org2", name: "Globex" },
                ],
                total: 2,
            })
            .mockResolvedValueOnce({ rows: [{ id: "org1", name: "Acme" }], total: 1 });
        fake.deleteAuthOrganization.mockResolvedValue(undefined);

        const { result } = renderHook(() => useOrganizations(), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(2);
        });

        // Plain client.* call — mutations are NOT wrapped by this hook layer,
        // per the design doc's "mutation ergonomics" section.
        await fake.asClient.deleteAuthOrganization({ organizationId: "org2" });

        result.current.refetch();

        await waitFor(() => {
            expect(result.current.data).toHaveLength(1);
        });

        expect(result.current.data?.[0]?.["id"]).toBe("org1");
        expect(fake.listAuthOrganizations).toHaveBeenCalledTimes(2);
        expect(fake.deleteAuthOrganization).toHaveBeenCalledWith({ organizationId: "org2" });
    });
});

describe("useImpersonate", () => {
    it("resolves an AuthImpersonation token and does NOT call client.setAuthToken (no silent session swap)", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();
        const impersonation: AuthImpersonation = { token: "imp-token-123", user: user("target-user") };

        fake.impersonateAuthUser.mockResolvedValue(impersonation);

        const { result } = renderHook(() => useImpersonate(), { wrapper: wrapper(fake.asClient) });

        expect(result.current.pending).toBe(false);

        const resolved = await result.current.impersonate("target-user");

        expect(resolved).toEqual(impersonation);
        expect(fake.impersonateAuthUser).toHaveBeenCalledWith({ userId: "target-user" });

        await waitFor(() => {
            expect(result.current.data).toEqual(impersonation);
        });

        expect(result.current.pending).toBe(false);
        expect(result.current.error).toBeUndefined();

        // The security-sensitive assertion: minting an impersonation token must
        // never silently swap the ADMIN's own session. The caller decides what
        // to do with the resolved token (see the hook's docstring + the design
        // doc's open question on the eventual UX).
        expect(fake.setAuthToken).not.toHaveBeenCalled();
    });

    it("surfaces a rejected impersonation attempt as `error`", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.impersonateAuthUser.mockRejectedValue(new Error("forbidden"));

        const { result } = renderHook(() => useImpersonate(), { wrapper: wrapper(fake.asClient) });

        await expect(result.current.impersonate("target-user")).rejects.toThrow("forbidden");

        await waitFor(() => {
            expect(result.current.error).toBeInstanceOf(Error);
        });

        expect(result.current.error?.message).toBe("forbidden");
        expect(result.current.data).toBeUndefined();
        expect(fake.setAuthToken).not.toHaveBeenCalled();
    });
});

describe("cross-admin cache separation", () => {
    it("a token swap on the same client fetches fresh rather than reusing the prior admin's cache entry", async () => {
        expect.hasAssertions();

        const fake = createAdminAuthFakeClient();

        fake.listAuthUsers
            .mockResolvedValueOnce({ rows: [user("admin-a-u1")], total: 1 })
            .mockResolvedValueOnce({ rows: [user("admin-b-u1"), user("admin-b-u2")], total: 2 });

        fake.setAuthToken("token-admin-a");

        const { result } = renderHook(() => useAuthUsers(), { wrapper: wrapper(fake.asClient) });

        await waitFor(() => {
            expect(result.current.data).toHaveLength(1);
        });

        expect(result.current.data?.[0]?.id).toBe("admin-a-u1");
        expect(fake.listAuthUsers).toHaveBeenCalledTimes(1);

        // Swap the acting admin on the SAME `LunoraClient` instance — the
        // `useSyncExternalStore` subscription on `onAuthTokenChange` should
        // re-render with a distinct `queryKey`, triggering a fresh fetch
        // rather than reading admin A's rows back out of the cache.
        fake.setAuthToken("token-admin-b");

        await waitFor(() => {
            expect(result.current.data).toHaveLength(2);
        });

        expect(result.current.data?.[0]?.id).toBe("admin-b-u1");
        expect(fake.listAuthUsers).toHaveBeenCalledTimes(2);
    });
});
