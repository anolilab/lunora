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

/** `v.any()` reached through an aliased namespace import. */
const ALIASED_ANY = `
    import { v as val } from "@lunora/values";
    import { mutation } from "@lunora/server";

    export const update = mutation({
        args: { payload: val.any() },
        handler: async () => null,
    });
`;

/** `v.any()` reached through a destructured shorthand. */
const DESTRUCTURED_ANY = `
    import { mutation } from "@lunora/server";

    const { any } = v;

    export const update = mutation({
        args: { payload: any() },
        handler: async () => null,
    });
`;

/** `v.any()` returned by a same-file helper. */
const HELPER_ANY = `
    import { mutation } from "@lunora/server";

    const untyped = () => v.any();

    export const update = mutation({
        args: { payload: untyped() },
        handler: async () => null,
    });
`;

/** `v.any()` reached through a namespace import, which exposes `v` as a member. */
const NAMESPACE_ANY = `
    import * as values from "@lunora/values";
    import { mutation } from "@lunora/server";

    export const update = mutation({
        args: { payload: values.v.any() },
        handler: async () => null,
    });
`;

/** A helper's unbounded string that the call site bounds with `.max()`. */
const HELPER_BOUNDED_AT_SITE = `
    import { mutation } from "@lunora/server";

    const title = () => v.string();

    export const rename = mutation({
        args: { name: title().max(200) },
        handler: async () => null,
    });
`;

/** A helper returning an array of unbounded strings; the call-site `.max()` bounds the array only. */
const HELPER_ARRAY_BOUNDED_AT_SITE = `
    import { mutation } from "@lunora/server";

    const tags = () => v.array(v.string());

    export const tag = mutation({
        args: { tags: tags().max(3) },
        handler: async () => null,
    });
`;

/** A destructure of `any` inside one function does not bind `any` for another function. */
const NESTED_DESTRUCTURE = `
    import { mutation } from "@lunora/server";

    const scoped = () => {
        const { any } = v;

        return any();
    };

    export const update = mutation({
        args: { payload: any() },
        handler: async () => null,
    });
`;

/** A same-file helper whose local `v` shadows the validator namespace; its `v.any()` is not a validator call. */
const SHADOWED_V_IN_HELPER = `
    import { mutation } from "@lunora/server";

    const label = () => {
        const v = { any: () => "text" };

        return v.any();
    };

    export const update = mutation({
        args: { name: label() },
        handler: async () => null,
    });
`;

/** A same-file helper whose parameter `ns` shadows the namespace import `ns`; its `ns.v.any()` is not a validator call. */
const SHADOWED_NAMESPACE_IN_HELPER = `
    import * as ns from "@lunora/values";
    import { mutation } from "@lunora/server";

    const label = (ns: { v: { any: () => string } }) => ns.v.any();

    export const update = mutation({
        args: { name: label({ v: { any: () => "text" } }) },
        handler: async () => null,
    });
`;

/** A real namespace import `ns`, used directly: `ns.v.any()` is a validator call. */
const NAMESPACE_IMPORT_ANY = `
    import * as ns from "@lunora/values";
    import { mutation } from "@lunora/server";

    export const update = mutation({
        args: { payload: ns.v.any() },
        handler: async () => null,
    });
`;

/** A local function named `any` that is not the validator namespace. */
const UNRELATED_ANY = `
    import { mutation } from "@lunora/server";

    const any = () => 1;

    export const update = mutation({
        args: { payload: any() },
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

    it("flags a v.any() reached through an aliased namespace import", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "update.ts"), ALIASED_ANY, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
    });

    it("flags a v.any() reached through a destructured any", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "update.ts"), DESTRUCTURED_ANY, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
    });

    it("does NOT let a destructure inside one function bind `any` for another function", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "update.ts"), NESTED_DESTRUCTURE, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags a v.any() returned by a same-file helper", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "update.ts"), HELPER_ANY, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
    });

    it("flags a v.any() reached through a namespace import", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "update.ts"), NAMESPACE_ANY, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
    });

    it("does NOT flag a helper's string that the call site bounds", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "rename.ts"), HELPER_BOUNDED_AT_SITE, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("keeps the inner string unbounded when the call-site bound applies to the outer array", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "tag.ts"), HELPER_ARRAY_BOUNDED_AT_SITE, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.unboundedStringArgs).toStrictEqual(["tags"]);
    });

    it("does NOT flag a v.any() on a local v that shadows the validator namespace in a helper", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "update.ts"), SHADOWED_V_IN_HELPER, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT flag a v.any() on a namespace-import name shadowed by a helper parameter", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "update.ts"), SHADOWED_NAMESPACE_IN_HELPER, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags a v.any() on a real namespace import named ns", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "update.ts"), NAMESPACE_IMPORT_ANY, "utf8");

        const found = discoverArgumentValidators(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]?.anyArgs).toStrictEqual(["payload"]);
    });

    it("does NOT flag a non-validator call named any", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "update.ts"), UNRELATED_ANY, "utf8");

        expect(discoverArgumentValidators(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
