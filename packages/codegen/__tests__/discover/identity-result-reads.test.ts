import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverIdentityClaimReads from "../../src/discover/identity-claim-reads";

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const CONTRACT = `import { defineIdentity, v } from "@lunora/server";
export const identity = defineIdentity({ userId: v.string(), tenantId: v.optional(v.string()) });
`;

const run = () => discoverIdentityClaimReads(project, join(workdir, "lunora"));

describe("discoverIdentityClaimReads: reads off the getIdentity() result", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-identity-result-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags an undeclared key read straight off the awaited result", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = async (ctx) => (await ctx.auth.getIdentity())?.role;`);

        expect(run()).toMatchObject([{ declared: false, key: "role" }]);
    });

    it("does not flag a declared key read off the result", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = async (ctx) => (await ctx.auth.getIdentity())?.tenantId;`);

        expect(run()).toMatchObject([{ declared: true, key: "tenantId" }]);
    });

    it("flags keys destructured from the result", () => {
        expect.assertions(2);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = async (ctx) => { const { role, tenantId: t } = await ctx.auth.getIdentity(); return [role, t]; };`);

        const rows = run();

        expect(rows.map((row) => row.key)).toStrictEqual(["role", "tenantId"]);
        expect(rows.map((row) => row.declared)).toStrictEqual([false, true]);
    });

    it("flags property reads on a variable bound to the result, through its references", () => {
        expect.assertions(2);

        write("identity.ts", CONTRACT);
        write(
            "mutations.ts",
            `export const m = async (ctx) => { const who = await ctx.auth.getIdentity(); return who?.role === "admin" || who["seats"] > 1; };`,
        );

        const rows = run();

        expect(rows.map((row) => row.key)).toStrictEqual(["role", "seats"]);
        expect(rows.every((row) => !row.declared)).toBe(true);
    });

    it("does not follow a getIdentity() result that is not bound to a variable or destructured", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = async (ctx) => helper(await ctx.auth.getIdentity());`);

        expect(run()).toStrictEqual([]);
    });

    it("sees a claim read through a cast or non-null assertion on the result", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write(
            "mutations.ts",
            `export const m = async (ctx) => { const who = (await ctx.auth.getIdentity()) as Who; return [(await ctx.auth.getIdentity())!.role, (await ctx.auth.getIdentity() satisfies unknown as Who).plan, who!.seats]; };`,
        );

        expect(run().map((row) => row.key)).toStrictEqual(["role", "plan", "seats"]);
    });

    it("does not count a write to a bound result as a claim read", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write(
            "mutations.ts",
            `export const m = async (ctx) => { const who = await ctx.auth.getIdentity(); who.role = "x"; delete who["plan"]; return who.tenantId; };`,
        );

        expect(run().map((row) => row.key)).toStrictEqual(["tenantId"]);
    });

    it("does not follow a let binding, which can be repointed at another value", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = async (ctx, other) => { let who = await ctx.auth.getIdentity(); who = other; return who.role; };`);

        expect(run()).toStrictEqual([]);
    });

    it("reads a static bracket key written as a cast or template literal", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", 'export const m = async (ctx) => { const who = await ctx.auth.getIdentity(); return [who["role" as const], who[`seats`]]; };');

        expect(run().map((row) => row.key)).toStrictEqual(["role", "seats"]);
    });

    it("does not report a computed destructuring key as a claim", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write(
            "mutations.ts",
            `export const m = async (ctx, key) => { const { [key]: value, ["role"]: role } = await ctx.auth.getIdentity(); return [value, role]; };`,
        );

        expect(run().map((row) => row.key)).toStrictEqual(["role"]);
    });

    it("does not treat promise methods on an unawaited getIdentity() as claim reads", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("mutations.ts", `export const m = (ctx) => ctx.auth.getIdentity().then((who) => who).finally(() => undefined);`);

        expect(run()).toStrictEqual([]);
    });

    it("tracks nothing without a declared contract", () => {
        expect.assertions(1);

        write("mutations.ts", `export const m = async (ctx) => (await ctx.auth.getIdentity())?.role;`);

        expect(run()).toStrictEqual([]);
    });
});
