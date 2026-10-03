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

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverOwnerFieldWrites", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-owner-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
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

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

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

        write(
            "mutators.ts",
            `async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await persist(ctx, { userId: args.targetUserId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");

        expect(discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory))).toStrictEqual([
            { field: "userId", file: "mutators", line: 1, method: "insert", scope: { callers: ["createPost"], kind: "helper", name: "persist" } },
        ]);
    });

    it("still reports a helper's write when every caller forwards its own verified owner arg", () => {
        expect.assertions(1);

        write(
            "mutators.ts",
            `async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await persist(ctx, { userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const [found] = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        // Conservative: proving the helper's `args.userId` is the verified one needs data flow.
        expect(found?.ownerScoped).toBeUndefined();
    });

    // `applyOwnerScope` overwrites exactly `args[owner]` with the verified
    // identity, so ONLY that argument is laundered. Matching on the column name
    // alone would suppress a genuine act-as-any-user IDOR.
    it("does not mark a write of the owner COLUMN sourced from a different arg", () => {
        expect.assertions(2);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.targetUserId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found).toHaveLength(1);
        expect(found[0]?.ownerScoped).toBeUndefined();
    });

    // The shared taint hop takes the nearest preceding same-named declaration
    // regardless of `const`/`let` and never looks at assignments. Over-resolving
    // makes the taint predicate report MORE, which is safe; here the same hop is
    // what SILENCES a finding, so a reassignable alias must not qualify.
    it("does not mark a `let` alias that is reassigned to a different arg", () => {
        expect.assertions(2);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { let userId = args.userId; userId = args.targetUserId; await ctx.db.insert("posts", { userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found).toHaveLength(1);
        expect(found[0]?.ownerScoped).toBeUndefined();
    });

    it("does not mark a `let` alias even when it is never reassigned", () => {
        // Cheap to be strict: `const` is the only shape the docs show, and a
        // mutable binding cannot be proven safe without real symbol resolution.
        expect.assertions(1);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { let userId = args.userId; await ctx.db.insert("posts", { userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found[0]?.ownerScoped).toBeUndefined();
    });

    it("marks the owner column reached through one local const hop", () => {
        expect.assertions(1);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { const userId = args.userId; await ctx.db.insert("posts", { userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found[0]).toMatchObject({ ownerScoped: true });
    });

    it("still flags a DIFFERENT identity column in an owner-scoped mutator", () => {
        // `owner: "userId"` launders `userId` and nothing else — a `tenantId` taken
        // from `args` in the same impl is still caller-controlled.
        expect.assertions(2);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await ctx.db.insert("posts", { tenantId: args.tenantId, userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));
        const tenant = found.find((entry) => entry.field === "tenantId");

        expect(tenant).toBeDefined();
        expect(tenant?.ownerScoped).toBeUndefined();
    });

    it("still flags an owner-column write in a mutator that declares no `owner`", () => {
        expect.assertions(2);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found).toHaveLength(1);
        expect(found[0]?.ownerScoped).toBeUndefined();
    });

    it("flags an insert whose doc sets userId from args", () => {
        expect.assertions(2);

        write("create.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: args.userId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "create" }, field: "userId", file: "create", line: 1, method: "insert" });
    });

    it("flags a patch whose partial sets ownerId from args", () => {
        expect.assertions(2);

        write("rename.ts", `export const rename = mutation(async ({ ctx, args }) => { await ctx.db.patch(args.id, { ownerId: args.ownerId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "ownerId", method: "patch" });
    });

    it("flags a shorthand identity property bound to an args value through one local hop", () => {
        expect.assertions(2);

        write("hop.ts", `export const create = mutation(async ({ ctx, args }) => { const userId = args.userId; await ctx.db.insert("posts", { userId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insert" });
    });

    it("flags one offending element of an insertManyUnsafe array", () => {
        expect.assertions(2);

        write(
            "import.ts",
            `export const importRows = mutation(async ({ ctx, args }) => { await ctx.db.insertManyUnsafe("posts", [{ userId: args.userId }, { title: args.title }]); });`,
        );

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insertManyUnsafe" });
    });

    it("ignores an ownership column stamped from ctx", () => {
        expect.assertions(1);

        write("safe.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: ctx.auth.userId }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-identity column written from args", () => {
        expect.assertions(1);

        write("title.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { title: args.title }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores an ownership column set to a fixed literal", () => {
        expect.assertions(1);

        write("literal.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: "system" }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    // #957: `isArgsProperty` compared the TEXT `args`, so a closure inside the
    // impl declaring its own `args` laundered any value into an "owner-scoped"
    // write. `applyOwnerScope` verified the impl's parameter, not the closure's.
    describe("resolves the verified `args` by symbol, not by spelling", () => {
        const discover = (source: string): ReturnType<typeof discoverOwnerFieldWrites> => {
            write("mutators.ts", source);

            // A fresh project per fixture: a reused one keeps serving the first parse of `mutators.ts`.
            const fresh = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const lunoraDirectory = join(workdir, "lunora");

            return discoverOwnerFieldWrites(fresh, lunoraDirectory, [], discoverMutators(fresh, lunoraDirectory));
        };
        type Row = ReturnType<typeof discoverOwnerFieldWrites>[number];

        const rowAt = (found: ReadonlyArray<Row>, line: number): Row | undefined => found.find((row) => row.line === line);
        // Recorded AND not owner-scoped, i.e. the lint reports it at full severity.
        const expectReported = (row: Row | undefined): void => {
            expect(row).toBeDefined();
            expect(row).not.toHaveProperty("ownerScoped");
        };

        it("reports a write laundered through a nested closure's own `args` parameter", () => {
            expect.assertions(3);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async (ctx, args) => {
        const persist = async (args: { userId: string }) => ctx.db.insert("posts", { userId: args.userId }); // @nested
        await persist({ userId: args.targetUserId });
    },
});`;
            const found = discover(source);

            expect(found).toHaveLength(1);
            expect(found[0]).toMatchObject({ field: "userId", line: markerLine(source, "nested"), scope: { kind: "export", name: "createPost" } });
            expect(found[0]?.ownerScoped).toBeUndefined();
        });

        it("marks a nested closure that closes over the impl's own `args` as owner-scoped", () => {
            expect.assertions(2);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async (ctx, args) => {
        const persist = async () => ctx.db.insert("posts", { userId: args.userId }); // @closure
        await persist();
    },
});`;
            const found = discover(source);

            expect(found).toHaveLength(1);
            expect(found[0]).toMatchObject({ line: markerLine(source, "closure"), ownerScoped: true });
        });

        it("keeps a direct `args.userId` write in the impl owner-scoped", () => {
            expect.assertions(1);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    async server(ctx, args) {
        await ctx.db.insert("posts", { userId: args.userId }); // @direct
    },
});`;

            expect(discover(source)).toStrictEqual([
                {
                    field: "userId",
                    file: "mutators",
                    line: markerLine(source, "direct"),
                    method: "insert",
                    ownerScoped: true,
                    scope: { kind: "export", name: "createPost" },
                },
            ]);
        });

        it("reports writes from a `for` / `catch` / block binding that shadows `args`", () => {
            expect.assertions(7);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async (ctx, args) => {
        for (const args of [{ userId: "victim" }]) {
            await ctx.db.insert("posts", { userId: args.userId }); // @for
        }
        try {
            await ctx.db.insert("posts", { userId: args.userId }); // @own
        } catch (args) {
            await ctx.db.insert("posts", { userId: args.userId }); // @catch
        }
        {
            const args = { userId: "victim" };
            await ctx.db.insert("posts", { userId: args.userId }); // @block
        }
    },
});`;
            const found = discover(source);

            expectReported(rowAt(found, markerLine(source, "for")));
            expectReported(rowAt(found, markerLine(source, "catch")));
            expectReported(rowAt(found, markerLine(source, "block")));

            expect(rowAt(found, markerLine(source, "own"))).toMatchObject({ ownerScoped: true });
        });

        it("reports a write after the impl rebinds `args` or overwrites its owner member", () => {
            expect.assertions(4);

            const rebound = discover(`export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {
    args = { userId: args.targetUserId };
    await ctx.db.insert("posts", { userId: args.userId });
} });`);

            expectReported(rebound[0]);

            const overwritten = discover(`export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {
    args.userId = args.targetUserId;
    await ctx.db.insert("posts", { userId: args.userId });
} });`);

            expectReported(overwritten[0]);
        });

        // `applyOwnerScope` stamps the parsed args object BEFORE `server(context,
        // args)` is called, so a destructuring parameter reads the verified value.
        it("marks the owner binding of a destructured impl parameter as owner-scoped", () => {
            expect.assertions(3);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async (ctx, { userId, targetUserId: target }) => {
        await ctx.db.insert("posts", { userId }); // @owner
        await ctx.db.insert("posts", { userId: target }); // @other
    },
});`;
            const found = discover(source);

            expect(rowAt(found, markerLine(source, "owner"))).toMatchObject({ ownerScoped: true });

            // The spelling-based taint never saw positionally destructured args; a
            // sibling field is caller-controlled and must be recorded and reported.
            expectReported(rowAt(found, markerLine(source, "other")));
        });

        it("marks a `const` destructure of the verified `args`, but not a rebound destructured parameter", () => {
            expect.assertions(3);

            const destructured = discover(`export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => {
    const { userId } = args;
    await ctx.db.insert("posts", { userId });
} });`);

            expect(destructured[0]).toMatchObject({ ownerScoped: true });

            const rebound = discover(`export const createPost = defineMutator({ owner: "userId", server: async (ctx, { userId, targetUserId }) => {
    userId = targetUserId;
    await ctx.db.insert("posts", { userId });
} });`);

            expectReported(rebound[0]);
        });

        it("raises the laundered write as an ERROR through the advisor lint", () => {
            expect.assertions(2);

            const source = `export const createPost = defineMutator({
    owner: "userId",
    server: async (ctx, args) => {
        const persist = async (args: { userId: string }) => ctx.db.insert("posts", { userId: args.userId }); // @nested
        await persist({ userId: args.targetUserId });
        await ctx.db.insert("posts", { userId: args.userId }); // @own
    },
});`;
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
