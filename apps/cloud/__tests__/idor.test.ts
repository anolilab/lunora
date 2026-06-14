import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../cirrus/_generated/server";
import { revoke as revokeKey } from "../cirrus/deploy-keys";
import { revoke as revokeInvite } from "../cirrus/invitations";
import { remove as removeMember } from "../cirrus/members";
import { remove as removeSecret } from "../cirrus/secrets";

type Row = Record<string, unknown>;

/**
 * Caller `u1` is an owner of `org_1`; `get(id)` returns a row that belongs to a
 * different org. The delete/revoke must refuse — this guards the cross-org IDOR
 * where an admin of one org passes a foreign row id with their own org id.
 */
const makeCtx = (targetOrg: string) => {
    const writes: string[] = [];
    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: "u1" },
        db: {
            delete: (id: string) => {
                writes.push(id);

                return Promise.resolve();
            },
            get: () => Promise.resolve({ _id: "row_x", organizationId: targetOrg } as Row),
            members: {
                findMany: ({ where }: { where: Row }) =>
                    Promise.resolve({
                        page:
                            where.organizationId === "org_1" && where.userId === "u1"
                                ? [{ _id: "m1", organizationId: "org_1", role: "admin", userId: "u1" }]
                                : [],
                    }),
            },
            patch: (id: string) => {
                writes.push(id);

                return Promise.resolve();
            },
        },
    } as unknown as MutationCtx;

    return { ctx, writes };
};

const cases = [
    { fn: removeSecret, id: "secrets" },
    { fn: removeMember, id: "members" },
    { fn: revokeKey, id: "deployKeys" },
    { fn: revokeInvite, id: "invitations" },
] as const;

describe("cross-org IDOR guard on delete/revoke", () => {
    for (const { fn, id } of cases) {
        it(`rejects a foreign-org row in ${id}`, async () => {
            const { ctx, writes } = makeCtx("org_2");

            await expect(fn.handler(ctx, { id: "row_x" as never, organizationId: "org_1" as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(writes).toStrictEqual([]);
        });

        it(`allows a row that belongs to the caller's org in ${id}`, async () => {
            const { ctx, writes } = makeCtx("org_1");

            await fn.handler(ctx, { id: "row_x" as never, organizationId: "org_1" as never });
            expect(writes).toStrictEqual(["row_x"]);
        });
    }
});
