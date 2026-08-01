/**
 * Issue #283: `lunora codegen` was not reproducible from a cold `_generated/`.
 *
 * Pass 1 inferred every handler's return type against a ts-morph `Project` that
 * did not yet include the generated declarations (`Doc&lt;…>` chief among them,
 * for a handler whose return type is annotated against it) — so on a fresh
 * clone, CI, or after `rm -rf lunora/_generated`, that inference collapsed to
 * `unknown` and codegen WROTE the collapsed type into `api.ts`/`functions.ts`.
 * A second run re-inferred against the first run's own (now-present) output
 * and recovered.
 *
 * This handler's return type depends on nothing but a LOCAL relative import
 * (`./_generated/dataModel`, never `@lunora/server` itself) so the test proves
 * the fix without needing a resolvable `@lunora/server` in `node_modules` —
 * every other codegen unit test in this suite runs in a checker-degraded
 * sandbox for the same reason (see `discover-functions-any-token.test.ts`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    notes: defineTable({ text: v.string() }),
});
`;

// The return type depends only on \`./_generated/dataModel\`'s \`Doc<"notes">\` —
// present from the very first pass once the fix bootstraps it, absent (module
// not found) on a cold pass without the fix.
const NOTES = `import type { Doc } from "./_generated/dataModel";
import { query } from "@lunora/server";

export const getNote = query({
    args: {},
    handler: async (): Promise<Doc<"notes"> | null> => {
        return null;
    },
});
`;

describe("runCodegen — cold-start reproducibility (#283)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cold-start-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA, "utf8");
        writeFileSync(join(workdir, "lunora", "notes.ts"), NOTES, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("does not collapse a Doc<T>-typed return to `unknown` on the very first pass from a cold _generated/", () => {
        expect.assertions(2);

        // Precondition: genuinely cold — no `_generated/` directory exists yet.
        const result = runCodegen({ lint: false, projectRoot: workdir });

        expect(result.generated.api).not.toContain('getNote: FunctionReference<"query", {}, unknown>');
        expect(result.generated.api).toContain('getNote: FunctionReference<"query", {}, import("./dataModel.js").Doc_notes | null>;');
    });

    it("first-pass functions.ts/api.ts output equals a second pass's (fixpoint from pass 1)", () => {
        expect.assertions(2);

        const first = runCodegen({ lint: false, projectRoot: workdir });

        // A second, fully independent invocation (no injected `project`, so this
        // constructs its own ts-morph Project exactly as a second `lunora codegen`
        // process would) reading back what pass 1 wrote.
        const second = runCodegen({ lint: false, projectRoot: workdir });

        expect(second.generated.functions).toBe(first.generated.functions);
        expect(second.generated.api).toBe(first.generated.api);
    });
});
