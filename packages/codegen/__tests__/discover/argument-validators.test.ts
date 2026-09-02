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

/** A public mutation whose string args carry an enforced length bound (`.max()` / `.length()`), at any nesting — not flagged. */
const BOUNDED = `
    import { mutation } from "@lunora/server";

    const vSlug = v.string().max(64);

    export const rename = mutation({
        args: {
            name: v.string().min(1).max(256),
            code: v.string().length(8),
            nickname: v.optional(v.string().max(32)),
            tags: v.array(v.string().max(16)),
            slug: vSlug,
        },
        handler: async () => null,
    });
`;

/**
 * Every way the source TEXT can look bounded while the runtime accepts any
 * length: `.meta()` is pure metadata (no parse effect), a `.check()` may
 * predicate anything but length, and `length`/`max` may simply be words inside
 * a description string. All must stay flagged.
 */
const LOOKS_BOUNDED = `
    import { mutation } from "@lunora/server";

    const vName = v.string();

    export const rename = mutation({
        args: {
            metaOnly: v.string().meta({ schema: { maxLength: 64 } }),
            prefixCheck: v.string().check((value) => value.startsWith("x")),
            wordy: v.string().meta({ description: "max length of the name" }),
            minOnly: v.string().min(1),
            aliased: vName,
            nested: v.object({ inner: v.string().meta({ schema: { maxLength: 64 } }) }),
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

    it("does NOT flag a string arg with an enforced length bound", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "rename.ts"), BOUNDED, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags a string arg whose bound exists only in the source text, not the parser", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "rename.ts"), LOOKS_BOUNDED, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.unboundedStringArgs).toStrictEqual(["metaOnly", "prefixCheck", "wordy", "minOnly", "aliased", "nested"]);
    });

    it("skips internal procedures (server-trusted input)", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "sync.ts"), INTERNAL, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
