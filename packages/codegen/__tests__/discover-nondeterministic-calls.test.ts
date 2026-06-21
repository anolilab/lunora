import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverNondeterministicCalls from "../src/discover-nondeterministic-calls";

/** A mutation handler that reads wall-clock time via `Date.now()`. */
const MUTATION_DATE_NOW = `
    import { mutation } from "@lunora/server";

    export const sendMessage = mutation({
        args: {},
        handler: async (ctx) => {
            const now = Date.now();
            await ctx.db.insert("messages", { now });
        },
    });
`;

/** The same `Date.now()` call, but inside an action — must NOT be recorded. */
const ACTION_DATE_NOW = `
    import { action } from "@lunora/server";

    export const syncWithStripe = action({
        args: {},
        handler: async (ctx) => {
            const now = Date.now();
            return now;
        },
    });
`;

/** A query handler exercising every recognised non-deterministic callee. */
const QUERY_ALL_CALLEES = `
    import { query } from "@lunora/server";

    export const listThings = query({
        args: {},
        handler: async (ctx) => {
            const a = Math.random();
            const b = crypto.randomUUID();
            crypto.getRandomValues(new Uint8Array(8));
            await fetch("https://example.com");
            await globalThis.fetch("https://example.com");
            await self.fetch("https://example.com");
            return [a, b];
        },
    });
`;

/** A mutation reading the clock via `new Date()` and crypto via a global-wrapped receiver. */
const MUTATION_NEW_DATE = `
    import { mutation } from "@lunora/server";

    export const stamp = mutation({
        args: {},
        handler: async (ctx) => {
            const now = new Date();
            const id = globalThis.crypto.randomUUID();
            await ctx.db.insert("messages", { id, now });
        },
    });
`;

/** A deterministic mutation — no non-deterministic calls to record. */
const CLEAN_MUTATION = `
    import { mutation } from "@lunora/server";

    export const setName = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insert("users", {});
        },
    });
`;

let workdir: string;
let project: Project;

describe("discoverNondeterministicCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-nondet-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a Date.now() call inside a mutation handler as evidence", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "messages.ts"), MUTATION_DATE_NOW, "utf8");

        const calls = discoverNondeterministicCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "Date.now", exportName: "sendMessage", file: "messages", kind: "mutation" });
    });

    it("does NOT record a Date.now() call inside an action handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "sync.ts"), ACTION_DATE_NOW, "utf8");

        const calls = discoverNondeterministicCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(0);
    });

    it("records every recognised callee inside a query handler", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "things.ts"), QUERY_ALL_CALLEES, "utf8");

        const calls = discoverNondeterministicCalls(project, join(workdir, "lunora"));

        // Math.random, crypto.randomUUID, crypto.getRandomValues, fetch, globalThis.fetch, self.fetch.
        expect(calls.map((call) => call.callee).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "crypto.getRandomValues",
            "crypto.randomUUID",
            "fetch",
            "fetch",
            "fetch",
            "Math.random",
        ]);
        expect(calls.every((call) => call.exportName === "listThings" && call.kind === "query")).toBe(true);
    });

    it("records new Date() and a global-wrapped crypto call inside a mutation handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "stamp.ts"), MUTATION_NEW_DATE, "utf8");

        const calls = discoverNondeterministicCalls(project, join(workdir, "lunora"));

        expect(calls.map((call) => call.callee).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["crypto.randomUUID", "new Date"]);
    });

    it("records nothing for a deterministic mutation", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "users.ts"), CLEAN_MUTATION, "utf8");

        const calls = discoverNondeterministicCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(0);
    });
});
