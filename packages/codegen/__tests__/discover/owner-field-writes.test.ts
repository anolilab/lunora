import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromServerSchema, runAdvisor } from "@lunora/advisor";
import { defineSchema } from "@lunora/server";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMutators } from "../../src/discover/mutators";
import discoverOwnerFieldWrites from "../../src/discover/owner-field-writes";
import { markerLine } from "../call-site-fixture";

type Row = ReturnType<typeof discoverOwnerFieldWrites>[number];

let workdir: string;

/** Discover the owner-field writes of ONE fixture file, together with the mutators it declares. */
const discover = (source: string, file = "mutators.ts"): Row[] => {
    const lunoraDirectory = join(workdir, "lunora");
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    writeFileSync(join(lunoraDirectory, file), source, "utf8");

    return discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));
};

/** An exported owner-scoped mutator whose `server` impl takes `parameters` and runs `body`. */
const ownerMutator = (body: string, parameters = "ctx, args"): string =>
    `export const createPost = defineMutator({
    owner: "userId",
    server: async (${parameters}) => {
${body}
    },
});`;

const rowAt = (found: ReadonlyArray<Row>, line: number): Row | undefined => found.find((row) => row.line === line);

/** Recorded AND not owner-scoped, i.e. the lint reports it at full severity. */
const expectReported = (row: Row | undefined): void => {
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("ownerScoped");
};

describe("discoverOwnerFieldWrites", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-owner-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    // `defineMutator({ owner: "userId" })` makes `args.userId` the server-verified
    // identity before the `server` impl runs: `applyOwnerScope` rejects a call with
    // no identity, rejects a client-supplied value that disagrees, and overwrites
    // the column with the verified one. Writing it back out is the documented
    // shape, and flagging it at ERROR is a false positive on Lunora's own docs.
    it("marks a mutator writing the very column its `owner` declares as owner-scoped", () => {
        expect.assertions(2);

        const found = discover(ownerMutator(`await ctx.db.insert("posts", { userId: args.userId });`));

        // Recorded, not dropped — the lint declines to report it. Discovery
        // describes the code; judging it is the lint's job.
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", ownerScoped: true });
    });

    // Inside a helper `args` is the HELPER's parameter: the mutator can fill it
    // from anything, and `applyOwnerScope` only verified the mutator's own
    // `args.userId`. The act-as-any-user write must stay reported.
    it("never marks a write inside a helper owner-scoped, even when the mutator forwards another arg", () => {
        expect.assertions(1);

        const found = discover(`async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await persist(ctx, { userId: args.targetUserId }); } });`);

        expect(found).toStrictEqual([
            { field: "userId", file: "mutators", line: 1, method: "insert", scope: { callers: ["createPost"], kind: "helper", name: "persist" } },
        ]);
    });

    it("still reports a helper's write when every caller forwards its own verified owner arg", () => {
        expect.assertions(2);

        const found = discover(`async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await persist(ctx, { userId: args.userId }); } });`);

        // Conservative: proving the helper's `args.userId` is the verified one needs data flow.
        expectReported(found[0]);
    });

    // `applyOwnerScope` overwrites exactly `args[owner]` with the verified
    // identity, so ONLY that argument is laundered. Matching on the column name
    // alone would suppress a genuine act-as-any-user IDOR.
    it("does not mark a write of the owner COLUMN sourced from a different arg", () => {
        expect.assertions(3);

        const found = discover(ownerMutator(`await ctx.db.insert("posts", { userId: args.targetUserId });`));

        expect(found).toHaveLength(1);

        expectReported(found[0]);
    });

    // A reassignable alias must not qualify: the hop is what SILENCES a finding.
    it("does not mark a `let` alias that is reassigned to a different arg", () => {
        expect.assertions(2);

        expectReported(discover(ownerMutator(`let userId = args.userId; userId = args.targetUserId; await ctx.db.insert("posts", { userId });`))[0]);
    });

    it("does not mark a `let` alias even when it is never reassigned", () => {
        // Cheap to be strict: `const` is the only shape the docs show.
        expect.assertions(2);

        expectReported(discover(ownerMutator(`let userId = args.userId; await ctx.db.insert("posts", { userId });`))[0]);
    });

    it("marks the owner column reached through one local const hop", () => {
        expect.assertions(1);

        expect(discover(ownerMutator(`const userId = args.userId; await ctx.db.insert("posts", { userId });`))[0]).toMatchObject({ ownerScoped: true });
    });

    it("still flags a DIFFERENT identity column in an owner-scoped mutator", () => {
        // `owner: "userId"` launders `userId` and nothing else — a `tenantId` taken
        // from `args` in the same impl is still caller-controlled.
        expect.assertions(2);

        const found = discover(ownerMutator(`await ctx.db.insert("posts", { tenantId: args.tenantId, userId: args.userId });`));

        expectReported(found.find((entry) => entry.field === "tenantId"));
    });

    it("still flags an owner-column write in a mutator that declares no `owner`", () => {
        expect.assertions(3);

        const found = discover(
            `export const createPost = defineMutator({ server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); } });`,
        );

        expect(found).toHaveLength(1);

        expectReported(found[0]);
    });

    it("flags an insert whose doc sets userId from args", () => {
        expect.assertions(2);

        const found = discover(
            `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: args.userId }); });`,
            "create.ts",
        );

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "create" }, field: "userId", file: "create", line: 1, method: "insert" });
    });

    it("flags a patch whose partial sets ownerId from args", () => {
        expect.assertions(2);

        const found = discover(
            `export const rename = mutation(async ({ ctx, args }) => { await ctx.db.patch(args.id, { ownerId: args.ownerId }); });`,
            "rename.ts",
        );

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "ownerId", method: "patch" });
    });

    it("flags a shorthand identity property bound to an args value through one local hop", () => {
        expect.assertions(2);

        const found = discover(
            `export const create = mutation(async ({ ctx, args }) => { const userId = args.userId; await ctx.db.insert("posts", { userId }); });`,
            "hop.ts",
        );

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insert" });
    });

    // A procedure handler's args are recognized by the `args` KEY, so renaming the
    // local binding does not hide the write.
    it("flags a procedure handler that renames its `args` binding", () => {
        expect.assertions(2);

        const found = discover(
            `export const create = mutation(async ({ ctx, args: input }) => { await ctx.db.insert("posts", { userId: input.userId }); });`,
            "renamed.ts",
        );

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", scope: { kind: "export", name: "create" } });
    });

    it("flags one offending element of an insertManyUnsafe array", () => {
        expect.assertions(2);

        const found = discover(
            `export const importRows = mutation(async ({ ctx, args }) => { await ctx.db.insertManyUnsafe("posts", [{ userId: args.userId }, { title: args.title }]); });`,
            "import.ts",
        );

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insertManyUnsafe" });
    });

    it.each([
        ["an ownership column stamped from ctx", `{ userId: ctx.auth.userId }`],
        ["a non-identity column written from args", `{ title: args.title }`],
        ["an ownership column set to a fixed literal", `{ userId: "system" }`],
    ])("ignores %s", (_label, document) => {
        expect.assertions(1);

        expect(discover(`export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", ${document}); });`, "safe.ts")).toHaveLength(0);
    });

    // #957: the owner-scope check compared the TEXT `args`, so a closure inside
    // the impl declaring its own `args` laundered any value into an
    // "owner-scoped" write. `applyOwnerScope` verified the impl's parameter, not
    // the closure's.
    describe("resolves the verified `args` by symbol, not by spelling", () => {
        it("reports a write laundered through a nested closure's own `args` parameter", () => {
            expect.assertions(4);

            const source = ownerMutator(`        const persist = async (args: { userId: string }) => ctx.db.insert("posts", { userId: args.userId }); // @write
        await persist({ userId: args.targetUserId });`);
            const found = discover(source);

            expect(found).toHaveLength(1);
            expect(found[0]).toMatchObject({ field: "userId", line: markerLine(source, "write"), scope: { kind: "export", name: "createPost" } });

            expectReported(found[0]);
        });

        // A nested function's parameter is tainted by what flows into it, however it
        // is spelled, and is never owner-scoped.
        it.each([
            [
                "a renamed nested parameter",
                ownerMutator(`        const persist = async (data) => ctx.db.insert("posts", { userId: data.userId }); // @write
        await persist({ userId: args.targetUserId });`),
            ],
            [
                "a nested parameter shadowing a destructured owner binding",
                ownerMutator(
                    `        const persist = async (userId) => ctx.db.insert("posts", { userId }); // @write
        await persist(targetUserId);`,
                    "ctx, { userId, targetUserId }",
                ),
            ],
            [
                "a function with mixed call sites (one caller-controlled)",
                ownerMutator(`        const persist = async (data) => ctx.db.insert("posts", { userId: data.userId }); // @write
        await persist({ userId: ctx.auth.userId });
        await persist({ userId: args.targetUserId });`),
            ],
            [
                "a function with no visible call site",
                ownerMutator(`        const persist = async (data) => ctx.db.insert("posts", { userId: data.userId }); // @write`),
            ],
            [
                "a function passed on as a value",
                ownerMutator(`        const persist = async (data) => ctx.db.insert("posts", { userId: data.userId }); // @write
        await schedule(persist);`),
            ],
            [
                "a callback over a caller-controlled list",
                ownerMutator(`        await Promise.all(args.items.map((item) => ctx.db.insert("posts", { userId: item.userId }))); // @write`),
            ],
            [
                "a callback handed to an unknown function",
                ownerMutator(`        await each(rows, (row) => ctx.db.insert("posts", { userId: row.userId })); // @write`),
            ],
        ])("reports a write laundered through %s", (_label, source) => {
            expect.assertions(2);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it.each([
            [
                "a callback over rows read through `ctx.db`",
                ownerMutator(`        const rows = await ctx.db.query("posts").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
        await Promise.all(rows.map((row) => ctx.db.insert("audit", { userId: row.userId }))); // @write`),
            ],
            [
                "a function whose every call site passes the verified identity",
                ownerMutator(`        const persist = async (data) => ctx.db.insert("posts", { userId: data.userId }); // @write
        await persist({ userId: ctx.auth.userId });`),
            ],
            // The spelling `args` alone is not taint once, by symbol, it is a cleared nested parameter.
            [
                "a nested `args` parameter whose every call site passes the verified identity",
                ownerMutator(`        const persist = async (args) => ctx.db.insert("posts", { userId: args.userId }); // @write
        await persist({ userId: ctx.auth.userId });`),
            ],
        ])("does not record %s", (_label, source) => {
            expect.assertions(1);

            expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
        });

        const insert = (value: string): string => `ctx.db.insert("posts", { userId: ${value} })`;

        // Each body's `// @write` line must be recorded and reported.
        it.each([
            // A callback receiver is server-scoped only when ROOTED in the impl's `ctx`.
            ["a receiver filtered against ctx", `args.items.filter((i) => i.orgId === ctx.orgId).map((i) => ${insert("i.userId")}); // @write`],
            [
                "a variable bound to such a receiver",
                `const mine = args.items.filter((i) => i.orgId === ctx.orgId);\n        mine.forEach((i) => ${insert("i.userId")}); // @write`,
            ],
            ["an array literal mixing ctx and args", `[ctx.auth.userId, args.targetUserId].map((id) => ${insert("id")}); // @write`],
            ["a `??` fallback to ctx", `(args.items ?? ctx.defaults).map((i) => ${insert("i.userId")}); // @write`],
            ["a spread of args beside ctx", `[{ ...args, org: ctx.org }].map((p) => ${insert("p.targetUserId")}); // @write`],
            ["a helper called with ctx and args", `validate(ctx, args).then((a) => ${insert("a.targetUserId")}); // @write`],
            ["an awaited helper over args", `(await helper(ctx, args.items)).map((i) => ${insert("i.userId")}); // @write`],
            // Only receiver-iterating methods take taint from the receiver alone.
            ["`Array.from` over args", `Array.from(args.items, (i) => ${insert("i.userId")}); // @write`],
            ["a namespace `map` over args", `_.map(args.items, (i) => ${insert("i.userId")}); // @write`],
            ["`Array.prototype.map.call` over args", `Array.prototype.map.call(args.items, (i) => ${insert("i.userId")}); // @write`],
            ["a `reduce` seeded from args", `[0].reduce((acc) => ${insert("acc")}, args.targetUserId); // @write`],
            // Variables are followed past one hop.
            [
                "a helper over a destructured args list",
                `const { items } = args;\n        const uniq = dedupe(items);\n        uniq.forEach((i) => ${insert("i.userId")}); // @write`,
            ],
            [
                "a two-hop alias of args",
                `const items = args.items;\n        const list = items.slice(0);\n        list.map((i) => ${insert("i.userId")}); // @write`,
            ],
            [
                "a two-hop argument",
                `const persist = (d) => ${insert("d.userId")}; // @write\n        const t = args.targetUserId;\n        const u = t;\n        await persist({ userId: u });`,
            ],
            // Defaults inside a destructured parameter, and spread call arguments.
            [
                "a destructured parameter default",
                `const persist = ({ userId = args.targetUserId }) => ${insert("userId")}; // @write\n        await persist({});`,
            ],
            ["an argument shifted by a spread", `const persist = (d) => ${insert("d.userId")}; // @write\n        persist(...[], args);`],
            // A `for…of` variable takes the taint of what it iterates.
            ["a `for…of` over args", `for (const item of args.items) {\n            await ${insert("item.userId")}; // @write\n        }`],
        ])("reports %s", (_label, body) => {
            expect.assertions(2);

            const source = ownerMutator(`        ${body}`);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        // Rows read through `ctx.db` are server-scoped, even when the query filters on args.
        it.each([
            ["a `then` on a ctx.db read", `ctx.db.get(args.id).then((row) => ${insert("row.userId")}); // @write`],
            [
                "a `for…of` over ctx.db rows",
                `const rows = await ctx.db.query("posts").collect();\n        for (const row of rows) {\n            await ${insert("row.userId")}; // @write\n        }`,
            ],
            [
                "a recursive helper seeded with the verified identity",
                `const walk = (n) => { ${insert("n.userId")}; walk(n.child); }; // @write\n        walk({ userId: ctx.auth.userId });`,
            ],
        ])("does not record %s", (_label, body) => {
            expect.assertions(1);

            const source = ownerMutator(`        ${body}`);

            expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
        });

        it("marks a nested closure that closes over the impl's own `args` as owner-scoped", () => {
            expect.assertions(1);

            const source = ownerMutator(`        const persist = async () => ctx.db.insert("posts", { userId: args.userId }); // @write
        await persist();`);

            expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ ownerScoped: true });
        });

        it("keeps a direct `args.userId` write in a method-shorthand impl owner-scoped", () => {
            expect.assertions(1);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    async server(ctx, args) {
        await ctx.db.insert("posts", { userId: args.userId }); // @write
    },
});`;

            expect(discover(source)).toStrictEqual([
                {
                    field: "userId",
                    file: "mutators",
                    line: markerLine(source, "write"),
                    method: "insert",
                    ownerScoped: true,
                    scope: { kind: "export", name: "createPost" },
                },
            ]);
        });

        it.each([`args["userId"]`, `args?.userId`, `(args as { userId: string }).userId`])("marks `%s` owner-scoped", (read) => {
            expect.assertions(1);

            expect(discover(ownerMutator(`await ctx.db.insert("posts", { userId: ${read} });`))[0]).toMatchObject({ ownerScoped: true });
        });

        it.each([
            ["for", `for (const args of [{ userId: "victim" }]) {\n            await ctx.db.insert("posts", { userId: args.userId }); // @write\n        }`],
            [
                "catch",
                `try {\n            await run();\n        } catch (args) {\n            await ctx.db.insert("posts", { userId: args.userId }); // @write\n        }`,
            ],
            [
                "block",
                `{\n            const args = { userId: "victim" };\n            await ctx.db.insert("posts", { userId: args.userId }); // @write\n        }`,
            ],
        ])("reports a write from a `%s` binding that shadows `args`", (_label, body) => {
            expect.assertions(2);

            const source = ownerMutator(`        ${body}`);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        // Any use of the impl's `args` other than a plain member read may change
        // it where this cannot see, so the whole impl stops being owner-scoped.
        it.each([
            ["a rebound `args`", `args = { userId: args.targetUserId };`],
            ["an overwritten owner member", `args.userId = args.targetUserId;`],
            ["a write through an alias", `const alias = args; alias.userId = args.targetUserId;`],
            ["`Object.assign`", `Object.assign(args, { userId: args.targetUserId });`],
            ["a write through `as`", `(args as { userId: string }).userId = args.targetUserId;`],
            ["a write through parentheses", `(args).userId = args.targetUserId;`],
            ["a write through `!`", `args!.userId = args.targetUserId;`],
            ["a call it is passed to", `fix(args);`],
            ["a `var` redeclaration", `var args = { userId: args.targetUserId };`],
            ["`arguments`", `void arguments;`],
            ["a spread of it", `const copy = { ...args };`],
        ])("reports the owner write after %s", (_label, statement) => {
            expect.assertions(2);

            const source = ownerMutator(`        ${statement}
        await ctx.db.insert("posts", { userId: args.userId }); // @write`);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it("reports a read of `args` through `arguments`", () => {
            expect.assertions(2);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async function (ctx, args) {
        await ctx.db.insert("posts", { userId: arguments[1].userId }); // @write
    },
});`;

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it("reports a write through an alias of `args`", () => {
            expect.assertions(2);

            const source = ownerMutator(`        const alias = args;
        await ctx.db.insert("posts", { userId: alias.userId }); // @write`);

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        it.each([
            ["parenthesized", `(async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); })`],
            ["`as`-cast", `(async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); }) as never`],
            ["`satisfies`-checked", `(async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); }) satisfies unknown`],
        ])("resolves the write of a %s `server` impl", (_label, server) => {
            expect.assertions(1);

            expect(discover(`export const createPost = defineMutator({ owner: "userId", server: ${server} });`)[0]).toMatchObject({ ownerScoped: true });
        });

        // A higher-order wrapper could hand the impl different arguments than the
        // verified ones, so this stays fail-closed (alpha owner-scoped it).
        it("reports the write of a `server` impl passed through a wrapper", () => {
            expect.assertions(2);

            const found = discover(
                `export const createPost = defineMutator({ owner: "userId", server: wrap(async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); }) });`,
            );

            expectReported(found[0]);
        });

        // Resolved DOWN from the export's own top-level declaration: a nested,
        // same-named mutator's `args` is a nested function's parameter, never the
        // outer export's verified args.
        it("reports a write in a nested same-named mutator's `server` impl", () => {
            expect.assertions(2);

            const source = `export const save = defineMutator({
    owner: "userId",
    server: async (ctx, args) => {
        const save = defineMutator({
            owner: "userId",
            server: async (ctx, args) => {
                await ctx.db.insert("posts", { userId: args.userId }); // @write
            },
        });
        await save.handler(ctx, { userId: args.targetUserId });
    },
});`;

            expectReported(rowAt(discover(source), markerLine(source, "write")));
        });

        // `applyOwnerScope` stamps the parsed args object BEFORE `server(context,
        // args)` is called, so destructuring that parameter reads the verified value.
        it.each([`{ userId }`, `{ userId = "other" }`, `{ userId: uid }`])("marks the owner binding of a `%s` impl parameter owner-scoped", (parameter) => {
            expect.assertions(1);

            const value = parameter.includes("uid") ? "userId: uid" : "userId";

            expect(discover(ownerMutator(`await ctx.db.insert("posts", { ${value} });`, `ctx, ${parameter}`))[0]).toMatchObject({ ownerScoped: true });
        });

        // The spelling-based taint never saw positionally destructured or renamed
        // args; a sibling field is caller-controlled and must be recorded.
        it.each([
            ["a destructured sibling field", `ctx, { targetUserId: target }`, `{ userId: target }`],
            ["a renamed parameter's sibling field", `ctx, input`, `{ userId: input.targetUserId }`],
        ])("reports %s", (_label, parameters, document) => {
            expect.assertions(2);

            expectReported(discover(ownerMutator(`await ctx.db.insert("posts", ${document});`, parameters))[0]);
        });

        it("marks a renamed impl parameter's owner field owner-scoped", () => {
            expect.assertions(1);

            expect(discover(ownerMutator(`await ctx.db.insert("posts", { userId: input.userId });`, "ctx, input"))[0]).toMatchObject({ ownerScoped: true });
        });

        it("reports a destructured owner binding the impl reassigns", () => {
            expect.assertions(2);

            expectReported(discover(ownerMutator(`userId = targetUserId; await ctx.db.insert("posts", { userId });`, "ctx, { userId, targetUserId }"))[0]);
        });

        it("marks a `const` destructure of the verified `args` owner-scoped", () => {
            expect.assertions(1);

            expect(discover(ownerMutator(`const { userId } = args; await ctx.db.insert("posts", { userId });`))[0]).toMatchObject({ ownerScoped: true });
        });

        // Fail-closed: a `let` binding can be repointed, and proving it is not
        // needs data flow this does not do.
        it("reports a `let` destructure of the verified `args`", () => {
            expect.assertions(2);

            expectReported(discover(ownerMutator(`let { userId } = args; await ctx.db.insert("posts", { userId });`))[0]);
        });

        it("raises the laundered write as an ERROR through the advisor lint", () => {
            expect.assertions(2);

            const source = ownerMutator(`        const persist = async (args: { userId: string }) => ctx.db.insert("posts", { userId: args.userId }); // @nested
        await persist({ userId: args.targetUserId });
        await ctx.db.insert("posts", { userId: args.userId }); // @own`);
            const findings = runAdvisor({ ownerFieldWrites: discover(source), schema: fromServerSchema(defineSchema({})) }, { source: "static" }).filter(
                (finding) => finding.name === "owner_field_from_args_not_auth",
            );

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                cacheKey: `owner_field_from_args_not_auth:mutators:${markerLine(source, "nested").toString()}:userId`,
                level: "ERROR",
            });
        });
    });
});
