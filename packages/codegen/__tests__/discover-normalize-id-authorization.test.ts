import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverNormalizeIdAuthorization from "../src/discover-normalize-id-authorization";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const discover = () => discoverNormalizeIdAuthorization(project, join(workdir, "lunora"));
const rowFor = (exportName: string) => discover().find((row) => row.exportName === exportName);

// eslint-disable-next-line no-secrets/no-secrets -- the feeder function name, not a credential
describe("discoverNormalizeIdAuthorization", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-normalize-id-auth-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a public query that gates a get on a null-checked normalizeId result", () => {
        expect.assertions(2);

        write(
            "read.ts",
            `export const getPost = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (id === null) throw new Error("not found");
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getPost")).toBeDefined();
        expect(rowFor("getPost")).toMatchObject({
            mentionsOwnership: false,
            sinkMethod: "get",
            table: "posts",
            usesRls: false,
            visibility: "public",
        });
    });

    it("records a mutation whose patch sink is gated on normalizeId (bare-throw then-branch)", () => {
        expect.assertions(1);

        write(
            "update.ts",
            `export const updatePost = mutation(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("not found");
                await ctx.db.patch(id, args.patch);
            });`,
        );

        expect(rowFor("updatePost")).toMatchObject({ sinkMethod: "patch", table: "posts" });
    });

    it("records a delete sink", () => {
        expect.assertions(1);

        write(
            "remove.ts",
            `export const removePost = mutation(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (id === null) return;
                await ctx.db.delete(id);
            });`,
        );

        expect(rowFor("removePost")).toMatchObject({ sinkMethod: "delete" });
    });

    it("records a facade-form sink (ctx.db.<table>.get(id))", () => {
        expect.assertions(1);

        write(
            "facade.ts",
            `export const getFacade = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("nf");
                return ctx.db.posts.get(id);
            });`,
        );

        expect(rowFor("getFacade")).toMatchObject({ sinkMethod: "get", table: "posts" });
    });

    it("flags mentionsOwnership when the handler reads ctx.auth", () => {
        expect.assertions(1);

        write(
            "authed.ts",
            `export const getMine = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("nf");
                const post = await ctx.db.get(id);
                if (post.author !== ctx.auth.userId) throw new Error("forbidden");
                return post;
            });`,
        );

        expect(rowFor("getMine")).toMatchObject({ mentionsOwnership: true });
    });

    it("flags mentionsOwnership when the handler references an ownership-named identifier", () => {
        expect.assertions(1);

        write(
            "owned.ts",
            `export const getOwned = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("nf");
                const ownerId = args.ownerId;
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getOwned")).toMatchObject({ mentionsOwnership: true });
    });

    it("flags mentionsOwnership when identity comes from a helper that receives ctx", () => {
        expect.assertions(1);

        // Repro of the audit's F1: identity via a helper + an unlisted ownership column.
        // Pre-fix this recorded mentionsOwnership:false and the SECURITY lint fired on authorized code.
        write(
            "helper-identity.ts",
            `export const getInvoice = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("invoices", args.id);
                if (!id) throw new Error("nf");
                const authorized = await canAccess(ctx, id);
                if (!authorized) throw new Error("forbidden");
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getInvoice")).toMatchObject({ mentionsOwnership: true });
    });

    it("flags mentionsOwnership when it compares a loaded row's property, even for an unlisted column", () => {
        expect.assertions(1);

        // `spaceRef` is deliberately NOT in OWNERSHIP_IDENTIFIER_NAMES — proves the
        // property-comparison signal catches ownership checks list-free.
        write(
            "row-compare.ts",
            `export const getScoped = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("docs", args.id);
                if (!id) throw new Error("nf");
                const doc = await ctx.db.get(id);
                if (doc.spaceRef !== args.spaceRef) throw new Error("forbidden");
                return doc;
            });`,
        );

        expect(rowFor("getScoped")).toMatchObject({ mentionsOwnership: true });
    });

    it("flags mentionsOwnership for a newly-recognized ownership column name (customerId)", () => {
        expect.assertions(1);

        write(
            "customer.ts",
            `export const getByCustomer = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("invoices", args.id);
                if (!id) throw new Error("nf");
                const customerId = args.customerId;
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getByCustomer")).toMatchObject({ mentionsOwnership: true });
    });

    it("keeps mentionsOwnership false for a null gate that only compares the id against null", () => {
        expect.assertions(1);

        // The `id === null` gate must NOT read as an ownership comparison, or the lint would never fire.
        write(
            "idor.ts",
            `export const getRaw = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (id === null) throw new Error("nf");
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getRaw")).toMatchObject({ mentionsOwnership: false });
    });

    it("marks usesRls when the builder chain carries .use(rls(...))", () => {
        expect.assertions(1);

        write(
            "rls.ts",
            `export const getGuarded = query
                .use(rls([{ table: "posts", read: () => true }]))
                .query(async ({ args, ctx }) => {
                    const id = ctx.db.normalizeId("posts", args.id);
                    if (!id) throw new Error("nf");
                    return ctx.db.get(id);
                });`,
        );

        expect(rowFor("getGuarded")).toMatchObject({ usesRls: true });
    });

    it("classifies an internalMutation as internal visibility", () => {
        expect.assertions(1);

        write(
            "internal.ts",
            `export const getInternal = internalMutation(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("nf");
                await ctx.db.delete(id);
            });`,
        );

        expect(rowFor("getInternal")).toMatchObject({ visibility: "internal" });
    });

    it("records an empty table when the normalizeId table argument isn't a string literal", () => {
        expect.assertions(1);

        write(
            "dynamic.ts",
            `export const getDynamic = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId(args.table, args.id);
                if (!id) throw new Error("nf");
                return ctx.db.get(id);
            });`,
        );

        expect(rowFor("getDynamic")).toMatchObject({ table: "" });
    });

    it("does not record when there is no null gate on the normalized id", () => {
        expect.assertions(1);

        write(
            "ungated.ts",
            `export const getUngated = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                return ctx.db.get(id);
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record when the normalized id never reaches a get/patch/delete sink", () => {
        expect.assertions(1);

        write(
            "nosink.ts",
            `export const validateOnly = query(async ({ args, ctx }) => {
                const id = ctx.db.normalizeId("posts", args.id);
                if (!id) throw new Error("nf");
                return { valid: true };
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record an inline normalizeId use with no binding to gate", () => {
        expect.assertions(1);

        write(
            "inline.ts",
            `export const getInline = query(async ({ args, ctx }) => {
                return ctx.db.get(ctx.db.normalizeId("posts", args.id));
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a query that never calls normalizeId", () => {
        expect.assertions(1);

        write("plain.ts", `export const listPosts = query(async ({ ctx }) => ctx.db.posts.findMany());`);

        expect(discover()).toHaveLength(0);
    });
});
