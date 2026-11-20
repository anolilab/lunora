import { describe, expect, it } from "vitest";

import { remove, setRole } from "../lunora/members";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Two owners changing each other at once must not leave the organization without
 * an owner. The members table is `.global()` (D1), so each write commits alone:
 * both calls read the owner count before either writes, which is the interleaving
 * a pre-write count check cannot survive.
 */

const ORG = "org_1";

/**
 * Two owners' ctx doubles over one shared `members` table. The double's `patch`
 * and `delete` only record, so both are applied here: each call must see the
 * other's write. The first owner-count read of each call waits until `racers`
 * calls have made it, so none writes before all have counted.
 */
const racingOwners = (racers = 2) => {
    const members: Row[] = [owner(ORG, "usr_a"), owner(ORG, "usr_b")];
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothCounted = new Promise<void>((resolve) => {
        release = resolve;
    });

    const ownerContext = (userId: string) => {
        const { ctx } = makeCtx({ auditLog: [], members }, { userId });
        const database = ctx.db as unknown as Record<string, unknown> & {
            members: { findMany: (args: { where?: Row }) => Promise<{ page: Row[] }> };
        };
        const { findMany } = database.members;
        let counted = false;

        database.members.findMany = async (args) => {
            // Copies, as the store answers: a read must not see a write that lands after it.
            const { page } = await findMany(args);
            const result = {
                page: page.map((row) => {
                    return { ...row };
                }),
            };

            // The membership lookup names the user; the owner count does not.
            if (!counted && args.where?.["userId"] === undefined) {
                counted = true;
                arrivals += 1;

                if (arrivals === racers) {
                    release();
                }

                await bothCounted;
            }

            return result;
        };
        database["patch"] = (_table: string, id: string, patch: Row) => {
            Object.assign(members.find((row) => row["_id"] === id) ?? {}, patch);

            return Promise.resolve();
        };
        database["delete"] = (_table: string, id: string) => {
            members.splice(
                members.findIndex((row) => row["_id"] === id),
                1,
            );

            return Promise.resolve();
        };

        return ctx;
    };

    return { a: ownerContext("usr_a"), b: ownerContext("usr_b"), owners: () => members.filter((row) => row["role"] === "owner") };
};

describe("members: the last owner under concurrent changes", () => {
    it("keeps an owner when two owners remove each other at once", async () => {
        const { a, b, owners } = racingOwners();

        const results = await Promise.allSettled([
            remove.handler(a, { id: "mem_usr_b" as never, organizationId: ORG as never }),
            remove.handler(b, { id: "mem_usr_a" as never, organizationId: ORG as never }),
        ]);

        expect(owners().length).toBeGreaterThanOrEqual(1);
        expect(results.some((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "CONFLICT")).toBe(true);
    });

    it("keeps an owner when two owners demote each other at once", async () => {
        const { a, b, owners } = racingOwners();

        const results = await Promise.allSettled([
            setRole.handler(a, { id: "mem_usr_b" as never, organizationId: ORG as never, role: "admin" }),
            setRole.handler(b, { id: "mem_usr_a" as never, organizationId: ORG as never, role: "admin" }),
        ]);

        expect(owners().length).toBeGreaterThanOrEqual(1);
        expect(results.some((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "CONFLICT")).toBe(true);
    });

    it("still removes an owner while another owner remains", async () => {
        const { a, owners } = racingOwners(1);

        await expect(remove.handler(a, { id: "mem_usr_b" as never, organizationId: ORG as never })).resolves.toBeUndefined();
        expect(owners().map((row) => row["userId"])).toStrictEqual(["usr_a"]);
    });
});
