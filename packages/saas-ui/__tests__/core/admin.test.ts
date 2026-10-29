import { describe, expect, it, vi } from "vitest";

import type { AdminSubscriptionRow } from "../../src/core/admin-subscriptions";
import { selectSubscriptions, subscriptionsSubtitle, subscriptionStateOptions, subscriptionTotals } from "../../src/core/admin-subscriptions";
import type { AdminUserRow, AdminUsersClient, AuthClientResult } from "../../src/core/admin-users";
import {
    adminUsersPage,
    createAdminUsersController,
    createStopImpersonatingController,
    impersonatedUser,
    isSuspended,
    userActions,
    userJoined,
    userStatusLabel,
} from "../../src/core/admin-users";
import type { Plan } from "../../src/core/billing";
import type { OrganizationRow } from "../../src/core/types";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const HOUR = 3_600_000;

const user = (overrides: Partial<AdminUserRow> & { id: string }): AdminUserRow => {
    return { email: `${overrides.id}@example.com`, name: overrides.id, role: "user", ...overrides };
};

const ok = <T>(data: T): AuthClientResult<T> => {
    return { data };
};

const refused = (message: string): AuthClientResult<never> => {
    return { error: { message, status: 400 } };
};

/** A promise whose settlement the test controls — how a test waits on an in-flight call without a clock. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

const createClient = (users: ReadonlyArray<AdminUserRow> = []) => {
    return {
        banUser: vi.fn<AdminUsersClient["banUser"]>(async () => ok({})),
        impersonateUser: vi.fn<AdminUsersClient["impersonateUser"]>(async () => ok({})),
        listUsers: vi.fn<AdminUsersClient["listUsers"]>(async ({ query }) => {
            const from = query.offset ?? 0;

            return ok({ total: users.length, users: users.slice(from, from + query.limit) });
        }),
        stopImpersonating: vi.fn<AdminUsersClient["stopImpersonating"]>(async () => ok({})),
        unbanUser: vi.fn<AdminUsersClient["unbanUser"]>(async () => ok({})),
    };
};

describe("isSuspended", () => {
    it("reads an unexpired or open-ended ban as a suspension", () => {
        expect(isSuspended(user({ banned: true, id: "a" }), NOW)).toBe(true);
        expect(isSuspended(user({ banExpires: new Date(NOW + HOUR), banned: true, id: "a" }), NOW)).toBe(true);
        expect(isSuspended(user({ banned: false, id: "a" }), NOW)).toBe(false);
    });

    it("treats a lapsed ban as over, although better-auth still has the flag set", () => {
        expect(isSuspended(user({ banExpires: new Date(NOW - HOUR).toISOString(), banned: true, id: "a" }), NOW)).toBe(false);
    });
});

describe("userActions", () => {
    it("offers nothing on the viewer's own row", () => {
        expect(userActions(user({ id: "me" }), "me", NOW)).toStrictEqual({ impersonate: false, suspend: false, unsuspend: false });
    });

    it("offers suspend and impersonate on an active user", () => {
        expect(userActions(user({ id: "u1" }), "me", NOW)).toStrictEqual({ impersonate: true, suspend: true, unsuspend: false });
    });

    it("never offers to impersonate an admin, which better-auth would refuse", () => {
        expect(userActions(user({ id: "u1", role: "user,admin" }), "me", NOW).impersonate).toBe(false);
    });

    it("offers only the way back on a suspended user", () => {
        expect(userActions(user({ banned: true, id: "u1" }), "me", NOW)).toStrictEqual({ impersonate: false, suspend: false, unsuspend: true });
    });

    it("says when a user joined, whichever shape the date arrives in", () => {
        expect(userJoined(user({ createdAt: new Date(NOW - 2 * HOUR), id: "u1" }), NOW)).toBe("2h ago");
        expect(userJoined(user({ createdAt: new Date(NOW - 2 * HOUR).toISOString(), id: "u1" }), NOW)).toBe("2h ago");
        expect(userJoined(user({ id: "u1" }), NOW)).toBe("—");
    });

    it("labels a suspension with its reason", () => {
        expect(userStatusLabel(user({ banned: true, banReason: "chargeback", id: "u1" }), NOW)).toBe("Suspended — chargeback");
        expect(userStatusLabel(user({ id: "u1" }), NOW)).toBe("Active");
    });
});

describe("createAdminUsersController", () => {
    it("loads the newest users first, and searches by email", async () => {
        const client = createClient([user({ id: "u1" })]);
        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });

        await controller.actions.load();

        expect(controller.getState().users).toHaveLength(1);
        expect(client.listUsers).toHaveBeenLastCalledWith({ query: { limit: 50, offset: 0, sortBy: "createdAt", sortDirection: "desc" } });

        await controller.actions.search("  ada ");

        expect(client.listUsers).toHaveBeenLastCalledWith({
            query: { limit: 50, offset: 0, searchField: "email", searchOperator: "contains", searchValue: "ada", sortBy: "createdAt", sortDirection: "desc" },
        });
    });

    it("pages by offset, stops at the last page, and starts over on a search", async () => {
        const client = createClient(Array.from({ length: 5 }, (_, index) => user({ id: `u${String(index)}` })));
        const controller = createAdminUsersController(client, { limit: 2, onSessionChange: vi.fn() });

        await controller.actions.load();

        expect(adminUsersPage(controller.getState())).toStrictEqual({ hasNext: true, hasPrevious: false, label: "1–2 of 5" });

        await controller.actions.nextPage();
        await controller.actions.nextPage();

        expect(client.listUsers.mock.lastCall?.[0].query.offset).toBe(4);
        expect(controller.getState().users?.map((row) => row.id)).toStrictEqual(["u4"]);
        expect(adminUsersPage(controller.getState())).toStrictEqual({ hasNext: false, hasPrevious: true, label: "5–5 of 5" });

        await controller.actions.nextPage();

        expect(client.listUsers).toHaveBeenCalledTimes(3);

        await controller.actions.previousPage();

        expect(controller.getState().users?.map((row) => row.id)).toStrictEqual(["u2", "u3"]);

        await controller.actions.search("u");

        expect(client.listUsers.mock.lastCall?.[0].query.offset).toBe(0);
        expect(controller.getState().offset).toBe(0);
    });

    it("stays on the page it shows when turning the page fails", async () => {
        const client = createClient(Array.from({ length: 5 }, (_, index) => user({ id: `u${String(index)}` })));
        const controller = createAdminUsersController(client, { limit: 2, onSessionChange: vi.fn() });

        await controller.actions.load();
        client.listUsers.mockRejectedValueOnce(new Error("offline"));
        await controller.actions.nextPage();

        expect(controller.getState().status).toBe("error");
        expect(controller.getState().offset).toBe(0);
        expect(adminUsersPage(controller.getState()).label).toBe("1–2 of 5");

        await controller.actions.suspend("u1");

        expect(client.listUsers.mock.lastCall?.[0].query.offset).toBe(0);
    });

    it("keeps the term on screen when a search fails, and pages on with it", async () => {
        const client = createClient(Array.from({ length: 5 }, (_, index) => user({ id: `u${String(index)}` })));
        const controller = createAdminUsersController(client, { limit: 2, onSessionChange: vi.fn() });

        await controller.actions.search("u");
        await controller.actions.nextPage();
        client.listUsers.mockRejectedValueOnce(new Error("offline"));
        await controller.actions.search("zed");

        expect(controller.getState()).toMatchObject({ offset: 2, search: "u", status: "error" });
        expect(controller.getState().users?.map((row) => row.id)).toStrictEqual(["u2", "u3"]);

        await controller.actions.nextPage();

        expect(client.listUsers.mock.lastCall?.[0].query).toMatchObject({ offset: 4, searchValue: "u" });
    });

    it("keeps the page it is on when a write re-reads the list", async () => {
        const client = createClient(Array.from({ length: 3 }, (_, index) => user({ id: `u${String(index)}` })));
        const controller = createAdminUsersController(client, { limit: 2, onSessionChange: vi.fn() });

        await controller.actions.load();
        await controller.actions.nextPage();
        await controller.actions.suspend("u2");

        expect(client.listUsers.mock.lastCall?.[0].query.offset).toBe(2);
    });

    it("reads a full page as possibly not the last when the client gives no total", () => {
        const rows = [user({ id: "a" }), user({ id: "b" })];

        expect(adminUsersPage({ limit: 2, offset: 0, users: rows })).toStrictEqual({ hasNext: true, hasPrevious: false, label: "1–2" });
        expect(adminUsersPage({ limit: 3, offset: 0, users: rows }).hasNext).toBe(false);
        expect(adminUsersPage({ limit: 2, offset: 0, users: undefined }).hasNext).toBe(false);
    });

    it("drops a slower answer to an older search", async () => {
        const client = createClient();
        const slow = deferred<AuthClientResult<{ users: AdminUserRow[] }>>();

        client.listUsers.mockImplementationOnce(async () => slow.promise).mockImplementationOnce(async () => ok({ users: [user({ id: "fresh" })] }));

        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });
        const first = controller.actions.search("a");

        await controller.actions.search("ab");
        slow.resolve(ok({ users: [user({ id: "stale" })] }));
        await first;

        expect(controller.getState().users?.map((row) => row.id)).toStrictEqual(["fresh"]);
    });

    it("re-reads the list after a suspension, carrying the reason", async () => {
        const client = createClient([user({ id: "u1" })]);
        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });

        await expect(controller.actions.suspend("u1", " spam ")).resolves.toBe(true);

        expect(client.banUser).toHaveBeenCalledWith({ banReason: "spam", userId: "u1" });
        expect(client.listUsers).toHaveBeenCalledTimes(1);
    });

    it("unsuspends, then re-reads", async () => {
        const client = createClient();
        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });

        await expect(controller.actions.unsuspend("u1")).resolves.toBe(true);

        expect(client.unbanUser).toHaveBeenCalledWith({ userId: "u1" });
        expect(client.listUsers).toHaveBeenCalledTimes(1);
    });

    it("keeps a refused write's message on screen instead of reloading it away", async () => {
        const client = createClient();

        client.banUser.mockResolvedValueOnce(refused("You cannot ban yourself"));

        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });

        await expect(controller.actions.suspend("u1")).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({ error: "You cannot ban yourself", status: "error" });
        expect(client.listUsers).not.toHaveBeenCalled();
    });

    it("ignores a second write while one is in flight", async () => {
        const client = createClient();
        const pending = deferred<AuthClientResult<unknown>>();

        client.banUser.mockImplementationOnce(async () => pending.promise);

        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });
        const first = controller.actions.suspend("u1");

        expect(controller.getState().pendingUserId).toBe("u1");
        await expect(controller.actions.unsuspend("u2")).resolves.toBe(false);

        pending.resolve(ok({}));
        await first;

        expect(client.unbanUser).not.toHaveBeenCalled();
        expect(controller.getState().pendingUserId).toBeUndefined();
    });

    it("navigates after an impersonation starts, and only then", async () => {
        const onSessionChange = vi.fn();
        const client = createClient();

        client.impersonateUser.mockResolvedValueOnce(refused("You cannot impersonate admins"));

        const controller = createAdminUsersController(client, { onSessionChange });

        await expect(controller.actions.impersonate("admin")).resolves.toBe(false);
        expect(onSessionChange).not.toHaveBeenCalled();

        await expect(controller.actions.impersonate("u1")).resolves.toBe(true);
        expect(onSessionChange).toHaveBeenCalledTimes(1);
    });

    it("turns a network rejection into an error rather than a list stuck loading", async () => {
        const client = createClient();

        client.listUsers.mockRejectedValueOnce(new Error("Failed to fetch"));

        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });

        await controller.actions.load();

        expect(controller.getState()).toMatchObject({ error: "Failed to fetch", status: "error" });
    });

    it("disowns an answer that lands after destroy, and can load again", async () => {
        const client = createClient();
        const slow = deferred<AuthClientResult<{ users: AdminUserRow[] }>>();

        client.listUsers.mockImplementationOnce(async () => slow.promise);

        const controller = createAdminUsersController(client, { onSessionChange: vi.fn() });
        const first = controller.actions.load();

        controller.destroy();
        slow.resolve(ok({ users: [user({ id: "stale" })] }));
        await first;

        expect(controller.getState().users).toBeUndefined();

        await controller.actions.load();

        expect(controller.getState().users).toStrictEqual([]);
    });
});

describe("impersonation", () => {
    it("names who the admin is acting as, and nothing when they are themselves", () => {
        expect(impersonatedUser({ session: { impersonatedBy: "admin-1" }, user: { email: "ada@example.com", name: "Ada" } })).toBe("Ada");
        expect(impersonatedUser({ session: { impersonatedBy: "admin-1" }, user: { email: "ada@example.com", name: " " } })).toBe("ada@example.com");
        expect(impersonatedUser({ session: { impersonatedBy: null }, user: { email: "ada@example.com" } })).toBeUndefined();
        expect(impersonatedUser(null)).toBeUndefined();
    });

    it("stops, then navigates back to the admin's own session", async () => {
        const onSessionChange = vi.fn();
        const client = createClient();
        const controller = createStopImpersonatingController(client, { onSessionChange });

        await expect(controller.stop()).resolves.toBe(true);

        expect(client.stopImpersonating).toHaveBeenCalledTimes(1);
        expect(onSessionChange).toHaveBeenCalledTimes(1);
    });

    it("stays put and says why when stopping is refused", async () => {
        const onSessionChange = vi.fn();
        const client = createClient();

        client.stopImpersonating.mockResolvedValueOnce(refused("You are not impersonating anyone"));

        const controller = createStopImpersonatingController(client, { onSessionChange });

        await expect(controller.stop()).resolves.toBe(false);

        expect(controller.getState()).toStrictEqual({ error: "You are not impersonating anyone", status: "error" });
        expect(onSessionChange).not.toHaveBeenCalled();
    });
});

describe("selectSubscriptions", () => {
    const plans: Plan[] = [
        { blurb: "", currency: "USD", features: [], id: "free", name: "Free", priceMinor: 0 },
        { blurb: "", currency: "USD", features: [], id: "pro", name: "Pro", priceId: "price_pro", priceMinor: 2900 },
    ];

    const organization = (organizationId: string, name: string, slug: string): OrganizationRow => {
        return { _creationTime: NOW, _id: `o-${organizationId}`, name, organizationId, plan: "free", seats: 1, slug, status: "active", updatedAt: NOW };
    };

    const subscription = (overrides: Partial<AdminSubscriptionRow> & { referenceId: string }): AdminSubscriptionRow => {
        return {
            cancelAtPeriodEnd: false,
            priceId: "price_pro",
            provider: "stripe",
            providerSubscriptionId: `sub_${overrides.referenceId}`,
            quantity: 1,
            state: "active",
            ...overrides,
        };
    };

    const subscriptions = [
        subscription({ referenceId: "org-z" }),
        subscription({ referenceId: "org-b" }),
        subscription({ referenceId: "org-a", state: "past_due" }),
        subscription({ priceId: "price_legacy", referenceId: "org-gone", state: "canceled" }),
    ];
    const organizations = [organization("org-a", "Acme", "acme"), organization("org-b", "Beta", "beta-labs"), organization("org-z", "Zeta", "zeta")];

    it("names the organisation and plan, and puts dunning tenants first", () => {
        expect(selectSubscriptions(subscriptions, organizations, plans).map(({ organization: name, plan, state }) => `${name}:${plan}:${state}`)).toStrictEqual(
            ["Acme:Pro:past_due", "Beta:Pro:active", "Zeta:Pro:active", "org-gone:price_legacy:canceled"],
        );
    });

    it("names the plan a past-due subscription bills, which currentPlan would not", () => {
        expect(selectSubscriptions(subscriptions, organizations, plans, { search: "acme", state: "all" })[0]?.plan).toBe("Pro");
    });

    it("filters by state and by organisation name or slug", () => {
        expect(selectSubscriptions(subscriptions, organizations, plans, { search: "", state: "canceled" }).map((row) => row.organization)).toStrictEqual([
            "org-gone",
        ]);
        expect(selectSubscriptions(subscriptions, organizations, plans, { search: "LABS", state: "all" }).map((row) => row.organization)).toStrictEqual([
            "Beta",
        ]);
    });

    it("says when a subscription renews, or ends when it cancels at period end", () => {
        const end = Date.UTC(2026, 10, 28);
        const rows = [
            subscription({ currentPeriodEnd: end, referenceId: "org-a" }),
            subscription({ cancelAtPeriodEnd: true, currentPeriodEnd: end, referenceId: "org-b" }),
            subscription({ currentPeriodEnd: end, referenceId: "org-z", state: "canceled" }),
        ];

        expect(selectSubscriptions(rows, organizations, plans).map((row) => row.renewal)).toStrictEqual(["Renews 2026-11-28", "Ends 2026-11-28", "—"]);
    });

    it("totals the paying and the past-due, and offers only the states present", () => {
        expect(subscriptionTotals(subscriptions)).toStrictEqual({ pastDue: 1, paying: 2 });
        expect(subscriptionStateOptions(subscriptions).map((option) => option.value)).toStrictEqual(["all", "past_due", "active", "canceled"]);
    });

    it("keys a row by provider and id, which is what makes it unique", () => {
        const rows = [
            subscription({ providerSubscriptionId: "sub_1", referenceId: "org-a" }),
            subscription({ provider: "polar", providerSubscriptionId: "sub_1", referenceId: "org-b" }),
        ];
        const listed = selectSubscriptions(rows, organizations, plans);

        expect(new Set(listed.map((row) => row.key))).toStrictEqual(new Set(["polar:sub_1", "stripe:sub_1"]));
        expect(listed.map((row) => row.id)).toStrictEqual(["sub_1", "sub_1"]);
        expect(selectSubscriptions(rows, organizations, plans, { search: "SUB_1", state: "all" })).toHaveLength(2);
    });

    it("says the totals cover only the loaded rows while more pages remain", () => {
        expect(subscriptionsSubtitle(subscriptions, false)).toBe("2 paying · 1 past due");
        expect(subscriptionsSubtitle(subscriptions, true)).toBe("2 paying · 1 past due in the 4 loaded");
    });
});
