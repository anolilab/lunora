import { describe, expect, it } from "vitest";

import { initLunora, v } from "../src/index";

const c = initLunora.dataModel<Record<string, never>>().create();

type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;

const run = (fn: unknown): Promise<unknown> => (fn as { handler: Handler }).handler({}, {});

describe(".output() rejects keys the validator does not declare", () => {
    it("fails loudly on a top-level undeclared key", async () => {
        expect.assertions(1);

        const fn = c.query.output(v.object({ id: v.string() })).query(() => ({ id: "a", secret: "x" }) as never);

        await expect(run(fn)).rejects.toThrow(/undeclared key\(s\): secret/);
    });

    it("fails loudly on an undeclared key inside a nested object", async () => {
        expect.assertions(1);

        const fn = c.query.output(v.object({ user: v.object({ id: v.string() }) })).query(() => ({ user: { id: "a", password: "x" } }) as never);

        await expect(run(fn)).rejects.toThrow(/undeclared key\(s\): password/);
    });

    it("fails loudly on an undeclared key inside an array element", async () => {
        expect.assertions(1);

        const fn = c.query.output(v.object({ rows: v.array(v.object({ id: v.string() })) })).query(() => ({ rows: [{ id: "a", email: "x@y" }] }) as never);

        await expect(run(fn)).rejects.toThrow(/undeclared key\(s\): email/);
    });
});
