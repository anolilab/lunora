/**
 * Rows both ports' card suites render. The two suites assert the same
 * behaviours against the same core and differ only in how they mount and
 * dispatch, so the data lives here once.
 */
import type { Mock } from "vitest";
import { vi } from "vitest";

import type { ActivityRow, AdminSubscriptionRow, AdminUserRow, AdminUsersClient, OrganizationRow, Plan, ProjectRow } from "../src/core";

const CREATED_SENTENCE = /created the project Website/u;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3_600_000;

const noop = async (): Promise<void> => {};

const project = (name: string, overrides: Partial<ProjectRow> = {}): ProjectRow => {
    return {
        _creationTime: NOW,
        _id: `p-${name}`,
        createdBy: "u1",
        name,
        organizationId: "org1",
        slug: name.toLowerCase(),
        ...overrides,
    };
};

const activity = (action: string, createdAt: number, meta?: Record<string, unknown>): ActivityRow => {
    return {
        _creationTime: createdAt,
        _id: `a-${createdAt.toString()}`,
        action,
        actorId: "u1",
        createdAt,
        meta,
        organizationId: "org1",
        subjectType: "project",
    };
};

const organization = (name: string, plan: string, seats: number): OrganizationRow => {
    return {
        _creationTime: NOW,
        _id: `o-${name}`,
        name,
        organizationId: `org-${name}`,
        plan,
        seats,
        slug: name.toLowerCase(),
        status: "active",
        updatedAt: NOW,
    };
};

const adminUser = (id: string, overrides: Partial<AdminUserRow> = {}): AdminUserRow => {
    return { createdAt: new Date(NOW - HOUR), email: `${id}@example.com`, id, name: id, role: "user", ...overrides };
};

type AdminClientMock = { [K in keyof AdminUsersClient]: Mock<AdminUsersClient[K]> };

/** A stand-in for better-auth's `authClient.admin` that answers every call with success. */
const adminClient = (users: ReadonlyArray<AdminUserRow>): AdminClientMock => {
    return {
        banUser: vi.fn<AdminUsersClient["banUser"]>(async () => {
            return { data: {} };
        }),
        impersonateUser: vi.fn<AdminUsersClient["impersonateUser"]>(async () => {
            return { data: {} };
        }),
        // Pages like better-auth: `offset`/`limit` slice the list, `total` counts all of it.
        listUsers: vi.fn<AdminUsersClient["listUsers"]>(async ({ query }) => {
            const from = query.offset ?? 0;

            return { data: { total: users.length, users: users.slice(from, from + query.limit) } };
        }),
        stopImpersonating: vi.fn<AdminUsersClient["stopImpersonating"]>(async () => {
            return { data: {} };
        }),
        unbanUser: vi.fn<AdminUsersClient["unbanUser"]>(async () => {
            return { data: {} };
        }),
    };
};

const PLANS: Plan[] = [
    { blurb: "", currency: "USD", features: [], id: "free", name: "Free", priceMinor: 0 },
    { blurb: "", currency: "USD", features: [], id: "pro", name: "Pro", priceId: "price_pro", priceMinor: 2900 },
];

const adminSubscription = (referenceId: string, state: string): AdminSubscriptionRow => {
    return {
        cancelAtPeriodEnd: false,
        priceId: "price_pro",
        provider: "stripe",
        providerSubscriptionId: `sub_${referenceId}`,
        quantity: 3,
        referenceId,
        state,
    };
};

export { activity, adminClient, adminSubscription, adminUser, CREATED_SENTENCE, HOUR, noop, NOW, organization, PLANS, project };
