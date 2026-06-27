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

import { discoverFunctions } from "../src/discover-functions";

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
        // `hasRefinement` (its predicate can't be represented in the IR).
        expect(result[0]?.args.text).toEqual({ kind: "string" });
        expect(result[0]?.args.name).toEqual({ hasRefinement: true, kind: "string" });
        // Unwrapping composes through v.optional and v.array.
        expect(result[0]?.args.id).toEqual({ inner: { kind: "string" }, kind: "optional" });
        expect(result[0]?.args.to).toEqual({ inner: { kind: "string" }, kind: "array" });
    });
});
