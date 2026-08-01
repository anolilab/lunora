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
    impersonateAuthUser: ReturnType<typeof vi.fn<(input: { userId: string }) => Promise<AuthImpersonation>>>;
    listAuthOrganizations: ReturnType<typeof vi.fn<(options: { limit?: number }) => Promise<AuthPage<Record<string, unknown>>>>>;
    listAuthSessions: ReturnType<typeof vi.fn<(options: { limit?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>>;
    listAuthUsers: ReturnType<typeof vi.fn<(options: Record<string, unknown>) => Promise<AuthPage<AuthUser>>>>;
    mutation: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
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
    const setAuthToken = vi.fn<(token: null | string) => void>();
    // Never called by these hooks — asserted against directly in a few tests
    // to prove the admin-gated HTTP path is used instead of the live/batch one.
    const query = vi.fn<() => Promise<unknown>>();
    const mutation = vi.fn<() => Promise<unknown>>();
    const subscribe = vi.fn<() => () => void>();

    const asClient = {
        deleteAuthOrganization,
        impersonateAuthUser,
        listAuthOrganizations,
        listAuthSessions,
        listAuthUsers,
        mutation,
        query,
        setAuthToken,
        subscribe,
    } as unknown as LunoraClient;

    return {
        asClient,
        deleteAuthOrganization,
        impersonateAuthUser,
        listAuthOrganizations,
        listAuthSessions,
        listAuthUsers,
        mutation,
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
