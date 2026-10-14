import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverQueries from "../../src/discover/queries";
import { scopeName } from "../call-site-fixture";

const FUNCTIONS = `
    import { query } from "@lunora/server";

    export const openRange = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").withIndex("by_expiry", (q) => q.gt("expiresAt", 0)).collect(),
    });

    export const boundedRange = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").withIndex("by_expiry", (q) => q.gt("expiresAt", 0).lt("expiresAt", 9)).collect(),
    });

    export const uncoveredFilter = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").withIndex("by_owner", (q) => q.eq("ownerId", "a")).filter((r) => r.expiresAt < 9 && r.ownerId === "a").collect(),
    });

    export const computedIndex = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").withIndex(indexName, (q) => q.eq("ownerId", "a")).collect(),
    });

    export const bareIndex = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").withIndex("by_expiry").collect(),
    });

    export const twoFilters = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").filter(isLive).filter((r) => r.expiresAt < 9).collect(),
    });

    export const bareFilter = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").filter(isExpired).collect(),
    });

    export const branchOpen = query({
        args: { flip: v.boolean() },
        handler: (ctx, args) => ctx.db.query("sessions").withIndex("by_expiry", (q) => (args.flip ? q.lt("expiresAt", 9) : q.gt("expiresAt", 0))).collect(),
    });

    export const branchBounded = query({
        args: { flip: v.boolean() },
        handler: (ctx, args) => ctx.db.query("sessions").withIndex("by_expiry", (q) => (args.flip ? q.lt("expiresAt", 9) : q.lt("expiresAt", 5))).collect(),
    });

    export const blockReturns = query({
        args: { flip: v.boolean() },
        handler: (ctx, args) =>
            ctx.db
                .query("sessions")
                .withIndex("by_expiry", (q) => {
                    if (args.flip) return q.lt("expiresAt", 1);
                    return q.gt("expiresAt", 0).lt("expiresAt", 9);
                })
                .collect(),
    });

    export const literalKeyFilter = query({
        args: {},
        handler: (ctx) => ctx.db.query("sessions").filter((row) => row["status"] === "open").collect(),
    });
`;

let workdir: string;
let project: Project;

describe("discoverQueries index and filter evidence", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-queries-index-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "sessions.ts"), FUNCTIONS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: false, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const readIn = (exportName: string) => discoverQueries(project, join(workdir, "lunora")).find((read) => scopeName(read.scope) === exportName);

    it("records the literal index name and the comparators its range callback calls", () => {
        expect.assertions(2);

        expect(readIn("openRange")?.index).toStrictEqual({ bounds: ["gt"], name: "by_expiry" });
        expect(readIn("boundedRange")?.index?.bounds).toStrictEqual(["gt", "lt"]);
    });

    it("reports a bare withIndex with no callback as open: no comparators at all", () => {
        expect.assertions(1);

        expect(readIn("bareIndex")?.index).toStrictEqual({ bounds: [], name: "by_expiry" });
    });

    it("leaves the index absent on a chain with no withIndex", () => {
        expect.assertions(1);

        expect(readIn("bareFilter")?.index).toBeUndefined();
    });

    it("unions the fields of every literal filter on a chain, and reads past a non-literal first one", () => {
        expect.assertions(1);

        expect(readIn("twoFilters")?.filterFields).toStrictEqual(["expiresAt"]);
    });

    it("records the fields the filter predicate reads off its row parameter", () => {
        expect.assertions(1);

        expect(readIn("uncoveredFilter")?.filterFields).toStrictEqual(["expiresAt", "ownerId"]);
    });

    it("leaves evidence undefined when the index name or filter predicate is not a literal", () => {
        expect.assertions(3);

        expect(readIn("computedIndex")?.index).toStrictEqual({ bounds: ["eq"], name: undefined });
        expect(readIn("bareFilter")?.filterFields).toBeUndefined();
        expect(readIn("openRange")?.filterFields).toBeUndefined();
    });

    it("bounds a range only by a comparator every branch applies", () => {
        expect.assertions(3);

        expect(readIn("branchOpen")?.index?.bounds).toStrictEqual([]);
        expect(readIn("branchBounded")?.index?.bounds).toStrictEqual(["lt"]);
        // Both returns carry `lt`, so every range the callback can return is bounded above.
        expect(readIn("blockReturns")?.index?.bounds).toStrictEqual(["lt"]);
    });

    it("reads a field named with a literal element access, as well as a property access", () => {
        expect.assertions(1);

        expect(readIn("literalKeyFilter")?.filterFields).toStrictEqual(["status"]);
    });
});
