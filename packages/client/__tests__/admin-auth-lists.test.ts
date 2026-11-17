import { describe, expect, it, vi } from "vitest";

import type { LunoraAdminClient } from "../src/admin/admin-client";
import { requireAdminAuthClient } from "../src/admin/admin-client";
import {
    adminAuthImpersonateMutation,
    adminAuthListHasMore,
    adminAuthListPlaceholder,
    adminAuthListQueryKey,
    adminAuthListQueryOptions,
    authOrganizationsList,
    authSessionsList,
    authSignUpInvitationsList,
    authUsersList,
    nextAdminAuthLimit,
    subscribeAdminAuthIdentity,
} from "../src/auth";
import type { AuthImpersonation, LunoraClient } from "../src/index";

const page = { rows: [], total: 0 };

/** The slice of `LunoraAdminClient` the admin-list core touches, with listener sets the test can fire. */
const fakeClient = () => {
    const tokenListeners = new Set<() => void>();
    const identityListeners = new Set<() => void>();
    const minted = { token: "imp-1", userId: "u1" } as unknown as AuthImpersonation;
    const client = {
        impersonateAuthUser: vi.fn<(input: { userId: string }) => Promise<AuthImpersonation>>(async () => minted),
        listAuthOrganizations: vi.fn<(options: unknown) => Promise<typeof page>>(async () => page),
        listAuthSessions: vi.fn<(options: unknown) => Promise<typeof page>>(async () => page),
        listAuthSignUpInvitations: vi.fn<(options: unknown) => Promise<typeof page>>(async () => page),
        listAuthUsers: vi.fn<(options: unknown) => Promise<typeof page>>(async () => page),
        onAuthTokenChange: (listener: () => void) => {
            tokenListeners.add(listener);

            return () => tokenListeners.delete(listener);
        },
        onIdentityChange: (listener: () => void) => {
            identityListeners.add(listener);

            return () => identityListeners.delete(listener);
        },
        setAuthToken: vi.fn<(token: null | string) => void>(),
    };

    return { client, identityListeners, lunora: client as unknown as LunoraAdminClient, minted, tokenListeners };
};

describe(adminAuthListQueryOptions, () => {
    it("reads the window through fetchPage and keys it by identity and limit", async () => {
        expect.assertions(4);

        const { client, lunora } = fakeClient();
        const list = authOrganizationsList(lunora);
        const options = adminAuthListQueryOptions(list, "subj:a", 100);

        await expect(options.queryFn()).resolves.toBe(page);
        expect(client.listAuthOrganizations).toHaveBeenCalledWith({ limit: 100 });
        expect(options.queryKey).toStrictEqual(adminAuthListQueryKey("subj:a", list, 100));
        expect(adminAuthListQueryOptions(list, "subj:b", 100).queryKey).not.toStrictEqual(options.queryKey);
    });

    it("never caches past the read, so a remount or focus re-fetches", () => {
        expect.assertions(1);

        const { lunora } = fakeClient();

        expect(adminAuthListQueryOptions(authOrganizationsList(lunora), null, 50).staleTime).toBe(0);
    });
});

describe(adminAuthListPlaceholder, () => {
    it("keeps the previous window only while the identity is unchanged", () => {
        expect.assertions(3);

        const { lunora } = fakeClient();
        const list = authOrganizationsList(lunora);
        const previous = { rows: [{ id: "o1" }], total: 5 };
        const previousKey = adminAuthListQueryKey("subj:a", list, 50);

        expect(adminAuthListPlaceholder(previous, previousKey, adminAuthListQueryKey("subj:a", list, 100))).toBe(previous);
        expect(adminAuthListPlaceholder(previous, previousKey, adminAuthListQueryKey("subj:b", list, 100))).toBeUndefined();
        expect(adminAuthListPlaceholder(previous, undefined, adminAuthListQueryKey("subj:a", list, 100))).toBeUndefined();
    });
});

describe(nextAdminAuthLimit, () => {
    it("grows the window by one page only while more rows exist", () => {
        expect.assertions(2);

        expect(nextAdminAuthLimit(50, 50, true)).toBe(100);
        expect(nextAdminAuthLimit(50, 50, false)).toBe(50);
    });
});

describe(requireAdminAuthClient, () => {
    it("returns an admin client and refuses a plain one", () => {
        expect.assertions(2);

        const { lunora } = fakeClient();
        const plain = { currentIdentity: () => null } as unknown as LunoraClient;

        expect(requireAdminAuthClient(lunora)).toBe(lunora);
        expect(() => requireAdminAuthClient(plain)).toThrow(/LunoraAdminClient/u);
    });
});

describe(adminAuthImpersonateMutation, () => {
    it("mints the session for the user and leaves the caller's own token alone", async () => {
        expect.assertions(3);

        const { client, lunora, minted } = fakeClient();

        await expect(adminAuthImpersonateMutation(lunora).mutationFn("u1")).resolves.toBe(minted);
        expect(client.impersonateAuthUser).toHaveBeenCalledWith({ userId: "u1" });
        expect(client.setAuthToken).not.toHaveBeenCalled();
    });
});

describe("admin auth list builders", () => {
    it("forward the window and filters to the matching client read", async () => {
        expect.assertions(4);

        const { client, lunora } = fakeClient();

        await authUsersList(lunora, { search: "ada", sortDirection: "desc" }).fetchPage(25);
        await authOrganizationsList(lunora).fetchPage(10);
        await authSignUpInvitationsList(lunora).fetchPage(10);
        await authSessionsList(lunora, { userId: "u1" }).fetchPage(5);

        expect(client.listAuthUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, search: "ada", sortDirection: "desc" }));
        expect(client.listAuthOrganizations).toHaveBeenCalledWith({ limit: 10 });
        expect(client.listAuthSignUpInvitations).toHaveBeenCalledWith({ limit: 10 });
        expect(client.listAuthSessions).toHaveBeenCalledWith({ limit: 5, userId: "u1" });
    });

    it("put every filter in the key so a filter change is a new cache entry", () => {
        expect.assertions(2);

        const { lunora } = fakeClient();

        expect(authUsersList(lunora, { search: "a" }).key).not.toStrictEqual(authUsersList(lunora, { search: "b" }).key);
        expect(authSessionsList(lunora, { userId: "u1" }).key).not.toStrictEqual(authSessionsList(lunora).key);
    });
});

describe(adminAuthListQueryKey, () => {
    it("partitions by identity at slot 1 and by window size at the end", () => {
        expect.assertions(4);

        const list = authOrganizationsList(fakeClient().lunora);

        expect(adminAuthListQueryKey(null, list, 50)[1]).toBe("anon");
        expect(adminAuthListQueryKey("subj:a", list, 50)[1]).toBe("subj:a");
        expect(adminAuthListQueryKey("subj:a", list, 50)).not.toStrictEqual(adminAuthListQueryKey("subj:b", list, 50));
        expect(adminAuthListQueryKey("subj:a", list, 100).at(-1)).toBe(100);
    });
});

describe(subscribeAdminAuthIdentity, () => {
    it("fires on a token swap and on a cookie-only identity change, and unsubscribes both", () => {
        expect.assertions(4);

        const { identityListeners, lunora, tokenListeners } = fakeClient();
        const onChange = vi.fn<() => void>();
        const off = subscribeAdminAuthIdentity(lunora, onChange);

        for (const listener of tokenListeners) {
            listener();
        }

        expect(onChange).toHaveBeenCalledTimes(1);

        for (const listener of identityListeners) {
            listener();
        }

        expect(onChange).toHaveBeenCalledTimes(2);

        off();

        expect(tokenListeners.size).toBe(0);
        expect(identityListeners.size).toBe(0);
    });
});

describe(adminAuthListHasMore, () => {
    it("is true only while the loaded window is short of the total", () => {
        expect.assertions(3);

        expect(adminAuthListHasMore(undefined)).toBe(false);
        expect(adminAuthListHasMore({ rows: [1], total: 2 })).toBe(true);
        expect(adminAuthListHasMore({ rows: [1, 2], total: 2 })).toBe(false);
    });
});
