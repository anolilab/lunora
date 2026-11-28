import { describe, expect, test } from "vitest";

import type { IdentityAuth } from "../../../templates/saas/lunora/authorize-shard";
import { authorizeShard, resolveIdentity } from "../../../templates/saas/lunora/authorize-shard";

/*
 * The saas template's tenant boundary: where a caller may go (`authorizeShard`)
 * and which tenant the session is allowed to claim (`resolveIdentity`).
 */
describe("saas authorizeShard", () => {
    const orgB = { activeOrganizationId: "org_b", userId: "user_b" };

    test("refuses another organization's shard", () => {
        expect(authorizeShard({ identity: orgB, shardKey: "org_a" })).toBe(false);
    });

    test("admits the caller's own organization's shard", () => {
        expect(authorizeShard({ identity: orgB, shardKey: "org_b" })).toBe(true);
    });

    test("admits the root shard to any signed-in caller", () => {
        expect(authorizeShard({ identity: { userId: "user_c" }, shardKey: "__root__" })).toBe(true);
    });

    test("refuses a caller with no organization every tenant shard", () => {
        expect(authorizeShard({ identity: { userId: "user_c" }, shardKey: "org_a" })).toBe(false);
    });

    test("refuses an anonymous caller, the root shard included", () => {
        expect(authorizeShard({ identity: null, shardKey: "__root__" })).toBe(false);
        expect(authorizeShard({ identity: undefined, shardKey: "org_a" })).toBe(false);
    });
});

describe("saas resolveIdentity", () => {
    const fakeAuth = (members: { organizationId: string; role: string; userId: string }[], activeOrganizationId: string | null): IdentityAuth => ({
        $context: Promise.resolve({
            adapter: {
                findOne: async <T>(query: { model: string; where: { field: string; value: string }[] }): Promise<T | null> => {
                    const row = members.find(
                        (member) => query.model === "member" && query.where.every(({ field, value }) => (member as Record<string, string>)[field] === value),
                    );

                    return (row as T | undefined) ?? null;
                },
            },
        }),
        api: {
            getSession: async () => {
                return {
                    session: { activeOrganizationId, expiresAt: new Date(1_000) },
                    user: { email: "a@example.com", id: "user_a", name: "Ada" },
                };
            },
        },
    });
    const request = new Request("https://example.com");

    test("a current member gets the tenant and role claims", async () => {
        const identity = await resolveIdentity(fakeAuth([{ organizationId: "org_a", role: "owner", userId: "user_a" }], "org_a"), request);

        expect(identity).toMatchObject({ activeOrganizationId: "org_a", expiresAtMs: 1_000, orgId: "org_a", orgRole: "owner", userId: "user_a" });
    });

    test("a removed member gets no tenant claim, though the session still names the organization", async () => {
        const identity = await resolveIdentity(fakeAuth([{ organizationId: "org_a", role: "owner", userId: "someone_else" }], "org_a"), request);

        expect(identity?.userId).toBe("user_a");
        expect(identity?.activeOrganizationId).toBeUndefined();
        expect(identity?.orgId).toBeUndefined();
        expect(identity?.orgRole).toBeUndefined();
    });

    test("membership of a different organization is not membership of the session's", async () => {
        const identity = await resolveIdentity(fakeAuth([{ organizationId: "org_b", role: "admin", userId: "user_a" }], "org_a"), request);

        expect(identity?.activeOrganizationId).toBeUndefined();
    });

    test("a request with no session resolves to no identity", async () => {
        const auth = { ...fakeAuth([], null), api: { getSession: async () => null } };

        expect(await resolveIdentity(auth, request)).toBeNull();
    });
});
