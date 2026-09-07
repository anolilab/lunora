import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFlagReads from "../../src/discover/flag-reads";

/** A query handler that branches on a boolean flag — the hazard this feeder exists for. */
const QUERY_FLAG_BOOLEAN = `
    import { query } from "@lunora/server";

    export const listMessages = query({
        args: {},
        handler: async (ctx) => {
            const compact = await ctx.flags.boolean("compact-list", false);

            return compact ? [] : ctx.db.query("messages").collect();
        },
    });
`;

/** A query handler reading the full evaluation details variant. */
const QUERY_FLAG_DETAILS = `
    import { query } from "@lunora/server";

    export const listVariants = query({
        args: {},
        handler: async (ctx) => ctx.flags.details.string("copy-variant", "control"),
    });
`;

/** The same flag read, but inside a mutation — a mutation runs once, so it must NOT be recorded. */
const MUTATION_FLAG_BOOLEAN = `
    import { mutation } from "@lunora/server";

    export const sendMessage = mutation({
        args: {},
        handler: async (ctx) => {
            const strict = await ctx.flags.boolean("strict-validation", false);

            return strict;
        },
    });
`;

/** The same flag read inside an action — also point-in-time, also not recorded. */
const ACTION_FLAG_BOOLEAN = `
    import { action } from "@lunora/server";

    export const syncBilling = action({
        args: {},
        handler: async (ctx) => ctx.flags.boolean("billing-v2", false),
    });
`;

/** The reactive path: `useFlag` is a client subscription, not a `ctx.flags` handler read. */
const USE_FLAG_SUBSCRIPTION = `
    import { useFlag } from "@lunora/flags/web";

    export const compact = useFlag("compact-list", false);
`;

/** A destructured receiver — NOT recorded, matching the precedent feeders' surface-text matching. */
const QUERY_DESTRUCTURED_FLAGS = `
    import { query } from "@lunora/server";

    export const listDestructured = query({
        args: {},
        handler: async (ctx) => {
            const { flags } = ctx;

            return flags.boolean("compact-list", false);
        },
    });
`;

/** A query that never touches ctx.flags. */
const CLEAN_QUERY = `
    import { query } from "@lunora/server";

    export const listUsers = query({
        args: {},
        handler: async (ctx) => ctx.db.query("users").collect(),
    });
`;

let workdir: string;
let project: Project;

describe("discoverFlagReads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-flag-reads-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a ctx.flags.boolean() read inside a query handler with its method label", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "messages.ts"), QUERY_FLAG_BOOLEAN, "utf8");

        const reads = discoverFlagReads(project, join(workdir, "lunora"));

        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages" });
    });

    it("peels the details namespace so the label names the evaluation performed", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "variants.ts"), QUERY_FLAG_DETAILS, "utf8");

        const reads = discoverFlagReads(project, join(workdir, "lunora"));

        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ callee: "ctx.flags.details.string", exportName: "listVariants", file: "variants" });
    });

    it("does NOT record a ctx.flags read inside a mutation handler", () => {
        expect.assertions(1);

        // A mutation runs at most once per logical write — nothing subscribes to it,
        // so a point-in-time flag evaluation there has no staleness to warn about.
        writeFileSync(join(workdir, "lunora", "send.ts"), MUTATION_FLAG_BOOLEAN, "utf8");

        expect(discoverFlagReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT record a ctx.flags read inside an action handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "billing.ts"), ACTION_FLAG_BOOLEAN, "utf8");

        expect(discoverFlagReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT record a useFlag subscription — that IS the reactive path", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "client-flags.ts"), USE_FLAG_SUBSCRIPTION, "utf8");

        expect(discoverFlagReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT record a destructured `const { flags } = ctx` receiver", () => {
        expect.assertions(1);

        // Deliberate parity with the precedent feeders, which match receivers by
        // surface text and so miss `const { random } = Math` in exactly the same way.
        // Resolving the binding would need the type checker; the shared blind spot is
        // preferable to this one lint behaving differently from its siblings.
        writeFileSync(join(workdir, "lunora", "destructured.ts"), QUERY_DESTRUCTURED_FLAGS, "utf8");

        expect(discoverFlagReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records nothing for a query that never touches ctx.flags", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "users.ts"), CLEAN_QUERY, "utf8");

        expect(discoverFlagReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
