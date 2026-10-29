/**
 * Boots the real schema and procedures against the in-memory harness.
 *
 * The property under test is the one the example exists to demonstrate: a
 * document's owner is whoever the session says it is, and nothing a caller
 * sends can change that or reach across it. The earlier shape also stored an
 * `organizationId` taken straight from `args` — a column shaped like a tenant
 * boundary that the server never verified — so the isolation assertions below
 * pin the boundary that is actually enforceable.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, expect, it } from "vitest";

import { create, list } from "../lunora/documents";
import schema from "../lunora/schema";

const NOT_SIGNED_IN_RE = /not signed in/i;

let t: ReturnType<typeof lunoraTest>;
let ada: ReturnType<typeof lunoraTest>;
let grace: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    t = lunoraTest(schema);
    ada = t.withIdentity({ userId: "u-ada" });
    grace = t.withIdentity({ userId: "u-grace" });
});

afterEach(() => {
    t.close();
});

it("refuses a signed-out caller on both sides", async () => {
    expect.assertions(2);

    await expect(t.query(list, {})).rejects.toThrow(NOT_SIGNED_IN_RE);
    await expect(t.mutation(create, { body: "b", title: "t" })).rejects.toThrow(NOT_SIGNED_IN_RE);
});

it("stamps the owner from the session, not from anything the caller sent", async () => {
    expect.assertions(2);

    await ada.mutation(create, { body: "b", title: "mine" });

    const rows = await t.run(async ({ db }) => db.query("documents").collect());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: "u-ada", title: "mine" });
});

it("never shows one user another user's documents", async () => {
    expect.assertions(2);

    await ada.mutation(create, { body: "b", title: "ada's" });
    await grace.mutation(create, { body: "b", title: "grace's" });

    const forAda = await ada.query(list, {});
    const forGrace = await grace.query(list, {});

    expect(forAda.map((row) => row.title)).toStrictEqual(["ada's"]);
    expect(forGrace.map((row) => row.title)).toStrictEqual(["grace's"]);
});

it("drops an ownership field a caller tries to smuggle in", async () => {
    expect.assertions(3);

    // Undeclared args are stripped, not rejected — so the assertion that matters
    // is about the ROW, not about the call failing. Nothing a caller sends
    // reaches an ownership column, which is what stops the old `organizationId`
    // (or any future owner-shaped field) from being reintroduced through `args`
    // without anyone noticing.
    await ada.mutation(create, { body: "b", organizationId: "org-someone-else", ownerId: "u-grace", title: "t" } as unknown as {
        body: string;
        title: string;
    });

    const rows = await t.run(async ({ db }) => db.query("documents").collect());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: "u-ada" });
    expect(rows[0]).not.toHaveProperty("organizationId");
});
