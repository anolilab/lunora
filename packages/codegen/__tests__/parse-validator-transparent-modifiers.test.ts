/**
 * Tests that discoverFunctions unwraps the transparent refinement/annotation
 * modifiers `.check(...)` and `.meta(...)` to the base validator's kind instead
 * of throwing "Unsupported validator kind". The `unbounded_string_arg` advisor
 * recommends exactly these for length bounds, so codegen must accept them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../src/discover/functions";

let workdir: string;

describe("transparent .check()/.meta() modifiers in codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-transparent-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("unwraps .meta() and .check() to the base kind, including under v.optional/v.array", () => {
        expect.assertions(5);

        writeFunction(
            "messages.ts",
            `
            import { mutation, v } from "@lunora/server";
            export const send = mutation({
                args: {
                    text: v.string().meta({ schema: { maxLength: 4096 } }),
                    id: v.optional(v.string().meta({ schema: { maxLength: 64 } })),
                    name: v.string().check((value) => value.length <= 128, { message: "too long", schema: { maxLength: 128 } }),
                    to: v.array(v.string().meta({ schema: { maxLength: 320 } })),
                    count: v.number(),
                },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        expect(result).toHaveLength(1);
        // `.meta(...)` / `.check(...)` are transparent — the arg keeps its base kind.
        // `.meta(...)` leaves the IR unchanged; `.check(...)` additionally records
        // `hasRefinement` (a narrowing) and `unmodelledRefinement` (its predicate
        // can't be represented in the IR, so the AOT compiler must decline it).
        expect(result[0]?.args.text).toEqual({ kind: "string" });
        expect(result[0]?.args.name).toEqual({ hasRefinement: true, kind: "string", unmodelledRefinement: true });
        // Unwrapping composes through v.optional and v.array.
        expect(result[0]?.args.id).toEqual({ inner: { kind: "string" }, kind: "optional" });
        expect(result[0]?.args.to).toEqual({ inner: { kind: "string" }, kind: "array" });
    });

    it("unwraps the named refinements (.max/.min/.email/.int/…) instead of aborting the run", () => {
        expect.assertions(5);

        // Every one of these is a `self.check(...)` at runtime, and every one is
        // published on `StringColumnValidator` / `NumberColumnValidator` /
        // `ArrayColumnValidator`. Unlisted, they reached the builder-member parser
        // as if `.max` were a validator factory and codegen ABORTED with
        // `Unsupported validator kind: max` — on a schema column as readily as on
        // an arg, so a documented API made the whole app ungeneratable.
        writeFunction(
            "messages.ts",
            `
            import { mutation, v } from "@lunora/server";
            export const send = mutation({
                args: {
                    text: v.string().max(200).min(1),
                    email: v.string().email(),
                    site: v.string().url(),
                    code: v.string().length(6).pattern(/^[a-z]+$/),
                    count: v.number().int().positive(),
                    tags: v.array(v.string()).max(5),
                },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        // Base kind preserved, and `hasRefinement` set: every one narrows the
        // accepted values. `unmodelledRefinement` is the half the AOT compiler
        // reads — set for every predicate the IR can't represent, so the compiler
        // declines rather than emitting a fast path that accepts what the
        // interpreted parser rejects. A `v.string().max(<literal>)` is the one
        // exception: `stringMaxLength` records the bound exactly, so `text` below
        // carries it — and still declines, because its `.min(1)` does not.
        expect(result[0]?.args.text).toEqual({ hasRefinement: true, kind: "string", stringMaxLength: 200, unmodelledRefinement: true });
        expect(result[0]?.args.email).toEqual({ hasRefinement: true, kind: "string", unmodelledRefinement: true });
        expect(result[0]?.args.code).toEqual({ hasRefinement: true, kind: "string", unmodelledRefinement: true });
        expect(result[0]?.args.count).toEqual({ hasRefinement: true, kind: "number", unmodelledRefinement: true });
        expect(result[0]?.args.tags).toEqual({ hasRefinement: true, inner: { kind: "string" }, kind: "array", unmodelledRefinement: true });
    });

    it("treats .serverDefault() as a column default instead of aborting the run", () => {
        expect.assertions(2);

        // Published on `ColumnValidator` and the documented way to make a field
        // non-client-controllable — so refusing to parse it took a security
        // control down together with the build, with the same
        // `Unsupported validator kind` abort as the refinements.
        writeFunction(
            "messages.ts",
            `
            import { mutation, v } from "@lunora/server";
            export const send = mutation({
                args: { owner: v.string().serverDefault(({ auth }) => auth.userId) },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        // The server fills it, so it is optional on insert — same as `.default()`.
        expect(result[0]?.args.owner?.kind).toBe("string");
        expect(result[0]?.args.owner?.column?.hasDefault).toBe(true);
    });

    it("follows a SHORTHAND arg to the const it names, like the longhand spelling", () => {
        expect.assertions(2);

        // A shorthand property is its own initializer, so the identifier the
        // parser sees is the property NAME — whose symbol is the property, not
        // the const. Resolution stopped there and the arg degraded to `unknown`
        // in the public api surface, while `bounded: bounded` resolved fine.
        // `object-shorthand` autofixes the working spelling into the broken one.
        writeFunction(
            "lib/validators.ts",
            `
            import { v } from "@lunora/server";
            export const shared = v.object({ done: v.boolean() });
        `,
        );
        writeFunction(
            "messages.ts",
            `
            import { mutation, v } from "@lunora/server";
            import { shared } from "./lib/validators";

            const bounded = v.string().max(200);

            export const send = mutation({
                args: { bounded, shared },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        expect(result[0]?.args.bounded).toEqual({ hasRefinement: true, kind: "string", stringMaxLength: 200 });
        // The aliased hop: an imported validator resolves through the shorthand too.
        expect(result[0]?.args.shared).toEqual({ kind: "object", shape: { done: { kind: "boolean" } } });
    });
});
