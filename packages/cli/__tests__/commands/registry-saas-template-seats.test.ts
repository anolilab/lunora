/**
 * The saas template's invitation seat holds (`templates/saas/lunora/seats.ts`),
 * EXECUTED over an in-memory `ctx.db` that enforces the table's unique index.
 */
import { describe, expect, it } from "vitest";

import type { Handler } from "../helpers/registry-runtime";
import { createDatabase, load } from "../helpers/registry-runtime";

interface Seats {
    holdInvitationSeat: Handler<{ email: string; limit: number | null; members: number; organizationId: string }, void>;
    releaseInvitationSeat: Handler<{ email: string; organizationId: string }, void>;
}

const NOW = 1_700_000_000_000;

const setup = async () => {
    const seats = await load<Seats>("templates", "saas", "lunora", "seats.ts");
    const database = createDatabase({ invitation_holds: [["organizationId", "email"]] });
    const clock = { now: NOW };
    const ctx = {
        db: database.db,
        get now() {
            return clock.now;
        },
    };
    const hold = async (email: string, { limit = 3, members = 1 }: { limit?: number | null; members?: number } = {}) =>
        seats.holdInvitationSeat({ args: { email, limit, members, organizationId: "org-1" }, ctx });

    return { clock, ctx, database, hold, seats };
};

describe("saas template invitation seat holds", () => {
    it("lets one invitation take the last seat and refuses the next, as two racing would be serialised", async () => {
        expect.assertions(2);

        const { database, hold } = await setup();

        // One member, a cap of three: two seats to invite into.
        await hold("a@x.test");
        await hold("b@x.test");

        await expect(hold("c@x.test")).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(database.rows("invitation_holds")).toHaveLength(2);
    });

    it("renews a re-sent invitation's hold instead of taking a second seat", async () => {
        expect.assertions(2);

        const { clock, database, hold } = await setup();

        await hold("a@x.test", { limit: 2 });
        clock.now += 1000;
        await hold("A@x.test", { limit: 2 });

        expect(database.rows("invitation_holds")).toHaveLength(1);
        expect(database.rows("invitation_holds")[0]!["expiresAt"]).toBe(clock.now + 48 * 60 * 60 * 1000);
    });

    it("gives the seat back on release, and lets a lapsed hold go", async () => {
        expect.assertions(2);

        const { clock, ctx, hold, seats } = await setup();

        await hold("a@x.test", { limit: 2 });
        await seats.releaseInvitationSeat({ args: { email: "a@x.test", organizationId: "org-1" }, ctx });

        await expect(hold("b@x.test", { limit: 2 })).resolves.toBeUndefined();

        // b's invitation lapses unanswered; its seat is free again.
        clock.now += 48 * 60 * 60 * 1000 + 1;

        await expect(hold("c@x.test", { limit: 2 })).resolves.toBeUndefined();
    });

    it("holds without a cap for an unmetered plan", async () => {
        expect.assertions(1);

        const { hold } = await setup();

        await expect(Promise.all(["a", "b", "c", "d"].map(async (name) => hold(`${name}@x.test`, { limit: null, members: 50 })))).resolves.toHaveLength(4);
    });
});
