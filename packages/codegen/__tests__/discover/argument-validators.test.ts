import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverArgumentValidators from "../../src/discover/argument-validators";

/** A public mutation with a `v.any()` arg and an unbounded `v.string()` arg. */
const WEAK_ARGS = `
    import { mutation } from "@lunora/server";

    export const update = mutation({
        args: {
            payload: v.any(),
            name: v.string(),
        },
        handler: async () => null,
    });
`;

/** A public mutation whose string arg carries a `.check()` length bound — not flagged. */
const BOUNDED = `
    import { mutation } from "@lunora/server";

    export const rename = mutation({
        args: {
            name: v.string().check((value) => value.length <= 256),
        },
        handler: async () => null,
    });
`;

/**
 * Everything the text-matching predicate accepted as a "length bound" and the
 * runtime does not enforce.
 *
 * `.meta()` is documented in `@lunora/values` as carrying pure metadata with no
 * effect on parsing — it reuses the parser unchanged — so a `maxLength` there is
 * a claim about the emitted JSON Schema, not a bound. The other three are the
 * bare substrings `length` and `max` turning up somewhere that is not a call on
 * the validator at all: a comment, a nested field NAME, a default value.
 */
const FALSE_BOUNDS = `
    import { mutation } from "@lunora/server";

    export const claimed = mutation({
        args: {
            viaMeta: v.string().meta({ schema: { maxLength: 200 } }),
            viaComment: v.string(), // max length enforced upstream
            viaSiblingName: v.object({ maxItems: v.number() , note: v.string() }),
            viaDefault: v.string().default("max"),
        },
        handler: async () => null,
    });
`;

/** The real bounds, in every spelling the runtime actually enforces. */
const REAL_BOUNDS = `
    import { mutation } from "@lunora/server";

    export const bounded = mutation({
        args: {
            viaMax: v.string().max(200),
            viaLength: v.string().length(8),
            viaOptional: v.optional(v.string().max(64)),
            viaChain: v.string().min(1).max(200),
        },
        handler: async () => null,
    });
`;

/** An internal mutation — server-trusted input, never recorded. */
const INTERNAL = `
    import { internalMutation } from "@lunora/server";

    export const sync = internalMutation({
        args: { blob: v.any() },
        handler: async () => null,
    });
`;

let workdir: string;
let project: Project;

describe("discoverArgumentValidators", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-args-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records the v.any() arg and the unbounded v.string() arg of a public mutation", () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "lunora", "update.ts"), WEAK_ARGS, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
        expect(found[0]?.unboundedStringArgs).toStrictEqual(["name"]);
    });

    it("does NOT flag a string arg with a length bound", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "rename.ts"), BOUNDED, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags a string the runtime does not actually bound", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "claimed.ts"), FALSE_BOUNDS, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found[0]?.unboundedStringArgs).toStrictEqual(["viaMeta", "viaComment", "viaSiblingName", "viaDefault"]);
    });

    it("does NOT flag the bounds the runtime does enforce", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "bounded.ts"), REAL_BOUNDS, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips internal procedures (server-trusted input)", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "sync.ts"), INTERNAL, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
