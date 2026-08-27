import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverArgumentValidators from "../src/discover-argument-validators";

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

    it("skips internal procedures (server-trusted input)", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "sync.ts"), INTERNAL, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
