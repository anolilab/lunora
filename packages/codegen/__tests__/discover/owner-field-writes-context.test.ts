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

        // `let { db } = ctx`: discovery follows it either way; only trust needs it unreassigned.
        it.each([
            ["an unreassigned `let { db } = ctx`", `let { db } = ctx;\n        await db.insert("posts", { userId: args.userId }); // @write`],
            [
                "a reassigned `let { db } = ctx`",
                `let { db } = ctx;\n        if (args.mirror) db = ctx.db;\n        await db.insert("posts", { userId: args.userId }); // @write`,
            ],
        ])("discovers the owner write through %s", (_label, body) => {
            expect.assertions(1);

            const source = ownerMutator(`        ${body}`);

            expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ field: "userId", ownerScoped: true });
        });

        // A `server: impl` declared on its own is the impl when nothing else can call it:
        // the runtime wraps `.server`, so the mutator is the only way in.
        it.each([
            [
                "a `const` arrow",
                `const impl = async (c, args) => {\n    await c.db.insert("posts", { userId: args.userId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server: impl });`,
            ],
            [
                "a `function` declaration",
                `async function impl(ctx, args) {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n}\nexport const createPost = defineMutator({ owner: "userId", server: impl });`,
            ],
            [
                "a shorthand `{ server }`",
                `const server = async (ctx, args) => {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server });`,
            ],
        ])("keeps the verified owner of a separately declared impl (%s) owner-scoped", (_label, source) => {
            expect.assertions(1);

            expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ field: "userId", ownerScoped: true });
        });

        it.each([
            [
                "a caller-chosen owner",
                `const impl = async (c, args) => {\n    await c.db.insert("posts", { userId: args.targetUserId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server: impl });`,
            ],
            [
                "an impl also called directly",
                `const impl = async (ctx, args) => {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server: impl });\nexport const other = mutation({ handler: (ctx, args) => impl(ctx, args) });`,
            ],
            [
                "an impl shared by two mutators",
                `const impl = async (ctx, args) => {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server: impl });\nexport const createDraft = defineMutator({ owner: "userId", server: impl });`,
            ],
            [
                "an impl that calls itself",
                `async function impl(ctx, args) {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n    if (!args.nested) await impl(ctx, { nested: true, userId: args.targetUserId });\n}\nexport const createPost = defineMutator({ owner: "userId", server: impl });`,
            ],
            [
                "an exported impl",
                `export const impl = async (ctx, args) => {\n    await ctx.db.insert("posts", { userId: args.userId }); // @write\n};\nexport const createPost = defineMutator({ owner: "userId", server: impl });`,
            ],
        ])("reports the owner write of a separately declared impl with %s", (_label, source) => {
            expect.assertions(2);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it.each(["mutation", "internalMutation", "query", "internalQuery"])(
            "discovers a write in a method-shorthand `%s` handler with a renamed ctx",
            (kind) => {
                expect.assertions(1);

                const source = `import { ${kind} } from "@lunora/server";
export const create = ${kind}({
    args: {},
    async handler(c, args) {
        await c.db.insert("posts", { userId: args.userId }); // @write
    },
});`;

                expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toMatchObject({ field: "userId", method: "insert" });
            },
        );
    });

    // Outside a mutator impl a value is server-scoped only when ROOTED in the ctx:
    // `x ?? args.userId` is an IDOR whatever `x` is, spelled `ctx` or not.
    const procedure = (body: string): string =>
        `import { mutation } from "@lunora/server";\nexport const create = mutation.input({}).mutation(async ({ ctx, args }) => {\n    ${body}\n});`;

    it.each([
        [
            "a destructured `auth` falling back to args",
            `const { auth } = ctx;\n    await ctx.db.insert("posts", { userId: auth.userId ?? args.userId }); // @write`,
        ],
        ["a spelled `ctx.auth` falling back to args", `await ctx.db.insert("posts", { userId: ctx.auth.userId ?? args.userId }); // @write`],
        ["a ctx read echoing args", `await ctx.db.insert("posts", { userId: ctx.db.asId("users", args.userId) }); // @write`],
    ])("reports an identity column written from %s", (_label, body) => {
        expect.assertions(1);

        const source = procedure(body);

        expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toMatchObject({ field: "userId", method: "insert" });
    });

    it.each([
        ["a destructured `auth`", `const { auth } = ctx;\n    await ctx.db.insert("posts", { userId: auth.userId }); // @write`],
        ["a row read by an args id", `await ctx.db.insert("posts", { userId: (await ctx.db.get(args.id)).ownerId }); // @write`],
        [
            "a const bound to such a row's owner",
            `const owner = (await ctx.db.get(args.id)).ownerId;\n    await ctx.db.insert("posts", { userId: owner }); // @write`,
        ],
    ])("does not record an identity column rooted in ctx through %s", (_label, body) => {
        expect.assertions(1);

        const source = procedure(body);

        expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toBeUndefined();
    });

    // A bare-factory handler's `args` is its second parameter, under any name.
    it.each([
        ["renamed", "c, a", "a.userId"],
        ["destructured", "c, { userId }", "userId"],
    ])("reports an identity column written from a %s positional `args`", (_label, parameters, value) => {
        expect.assertions(1);

        const source = `import { mutation } from "@lunora/server";\nexport const create = mutation({\n    handler: async (${parameters}) => {\n        await c.db.insert("posts", { userId: ${value} }); // @write\n    },\n});`;

        expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toMatchObject({ field: "userId", method: "insert" });
    });

    it("does not treat a helper's second parameter as `args`", () => {
        expect.assertions(1);

        const source = `const save = (c, a) => c.db.insert("posts", { userId: a.userId }); // @write\nexport const create = mutation({ handler: async (ctx, args) => save(ctx, { userId: ctx.auth.userId }) });`;

        expect(rowAt(discover(source, "posts.ts"), markerLine(source, "write"))).toBeUndefined();
    });
});
