import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markerLine } from "../call-site-fixture";
import { createOwnerFieldFixture, expectReported, ownerMutator, rowAt } from "./owner-field-writes-fixture";

describe("discoverOwnerFieldWrites: the ctx.db receiver", () => {
    const { discover, setUp, tearDown } = createOwnerFieldFixture();

    beforeEach(setUp);
    afterEach(tearDown);

    // The `ctx.db` receiver is resolved by symbol: matching only the spelling
    // `ctx.db` left every write through a renamed or destructured ctx invisible.
    describe("resolves the `ctx.db` receiver by symbol, not by spelling", () => {
        it.each([
            ["a renamed impl ctx", "c, args", `await c.db.insert("posts", { userId: args.targetUserId }); // @write`],
            ["a destructured impl `db`", "{ db }, args", `await db.insert("posts", { userId: args.targetUserId }); // @write`],
            ["`const { db } = ctx`", "ctx, args", `const { db } = ctx;\n        await db.insert("posts", { userId: args.targetUserId }); // @write`],
            [
                "`const database = ctx.db`",
                "ctx, args",
                `const database = ctx.db;\n        await database.patch(args.id, { userId: args.targetUserId }); // @write`,
            ],
            [
                "a `const` alias of a renamed ctx",
                "c, args",
                `const context = c;\n        await context.db.replace(args.id, { userId: args.targetUserId }); // @write`,
            ],
        ])("reports a caller-chosen owner written through %s", (_label, parameters, body) => {
            expect.assertions(2);

            const source = ownerMutator(`        ${body}`, parameters);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it.each([
            ["a renamed impl ctx", "c, args", `await c.db.insert("posts", { userId: args.userId }); // @write`],
            ["a destructured impl `db`", "{ db }, args", `await db.insert("posts", { userId: args.userId }); // @write`],
            ["`const { db } = ctx`", "ctx, args", `const { db } = ctx;\n        await db.insert("posts", { userId: args.userId }); // @write`],
        ])("keeps the verified owner written through %s owner-scoped", (_label, parameters, body) => {
            expect.assertions(1);

            const source = ownerMutator(`        ${body}`, parameters);

            expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ ownerScoped: true, scope: { kind: "export", name: "createPost" } });
        });

        it.each([
            [
                "a renamed `ctx` option",
                `export const create = mutation({ handler: async ({ ctx: c, args }) => { await c.db.insert("posts", { userId: args.userId }); } }); // @write`,
            ],
            [
                "a nested `{ ctx: { db } }` option",
                `export const create = mutation({ handler: async ({ ctx: { db }, args }) => { await db.insert("posts", { userId: args.userId }); } }); // @write`,
            ],
            [
                "a positional bare-factory handler",
                `import { mutation } from "@lunora/server";\nexport const create = mutation({ handler: async (c, args) => { await c.db.insert("posts", { userId: args.userId }); } }); // @write`,
            ],
        ])("reports a procedure handler writing through %s", (_label, source) => {
            expect.assertions(1);

            expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toMatchObject({
                field: "userId",
                method: "insert",
                scope: { kind: "export", name: "create" },
            });
        });

        it("does not treat a helper's first parameter as ctx", () => {
            expect.assertions(1);

            // Not a handler, so `store` is not resolved as ctx; under the spelling rule
            // a parameter named `ctx` still is.
            const source = `const save = (store, args) => store.db.insert("posts", { userId: args.userId });\nexport const create = mutation({ handler: async (ctx, args) => save(ctx, args) });`;

            expect(discover(source, "posts.ts")).toStrictEqual([]);
        });
    });
});
