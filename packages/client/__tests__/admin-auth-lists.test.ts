import { describe, expect, it, vi } from "vitest";

import {
    adminAuthListHasMore,
    adminAuthListQueryKey,
    authOrganizationsList,
    authSessionsList,
    authSignUpInvitationsList,
    authUsersList,
    subscribeAdminAuthIdentity,
} from "../src/auth";
import type { LunoraClient } from "../src/lunora-client";

const page = { rows: [], total: 0 };

/** The slice of `LunoraClient` the admin-list core touches, with listener sets the test can fire. */
const fakeClient = () => {
    const tokenListeners = new Set<() => void>();
    const identityListeners = new Set<() => void>();
    const client = {
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
    };

    return { client, identityListeners, lunora: client as unknown as LunoraClient, tokenListeners };
};

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
