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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line import/no-namespace -- vi.spyOn needs the module namespace object to intercept run-codegen's call to emitServer
import * as emitModule from "../src/emit";
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

    it("does not collapse a Doc<T> for a table added since the last run (warm but stale)", () => {
        expect.assertions(2);

        // The residual half of #283. The cold-start bootstrap only fires when a
        // generated file is MISSING, so an everyday edit — add a table, add a
        // handler that returns a row from it — still inferred pass 1 against the
        // PREVIOUS run's `dataModel.ts`, which has no `Doc_projects`. That is why
        // `lunora codegen` still needed two passes on a warm tree, and why a
        // project ends up wrapping the CLI in a run-until-the-hash-stops-changing
        // loop.
        runCodegen({ lint: false, projectRoot: workdir });

        writeFileSync(
            join(workdir, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    notes: defineTable({ text: v.string() }),
    projects: defineTable({ name: v.string() }),
});
`,
            "utf8",
        );
        writeFileSync(
            join(workdir, "lunora", "projects.ts"),
            `import type { Doc } from "./_generated/dataModel";
import { query } from "@lunora/server";

export const getProject = query({
    args: {},
    handler: async (): Promise<Doc<"projects"> | null> => {
        return null;
    },
});
`,
            "utf8",
        );

        const result = runCodegen({ lint: false, projectRoot: workdir });

        expect(result.generated.api).not.toContain('getProject: FunctionReference<"query", {}, unknown>');
        expect(result.generated.api).toContain('getProject: FunctionReference<"query", {}, import("./dataModel.js").Doc_projects | null>;');
    });

    it("does not rewrite server.ts a second time on a warm run for a project using a feature flag", () => {
        expect.assertions(1);

        // `ctx.kv` usage sets `hasKv`, so the bootstrap's schema-only render
        // (no feature flags) genuinely differs from the final render — the
        // exact precondition the double-write bug needed to reproduce.
        writeFileSync(
            join(workdir, "lunora", "cache.ts"),
            `import { query } from "@lunora/server";

export const read = query({
    args: {},
    handler: async ({ ctx }) => ctx.kv.get("k"),
});
`,
            "utf8",
        );

        // First (cold) run creates the full \`_generated/\` output on disk,
        // including the \`hasKv\`-narrowed \`server.ts\`.
        runCodegen({ lint: false, projectRoot: workdir });

        // Spies on the module's own \`emitServer\` export: the bootstrap phase
        // calls it with only \`{ schema, useUmbrella }\` (no feature flags), the
        // final phase with the full narrowed option set. Counting TOTAL calls
        // across the second run is enough to prove the bootstrap one didn't
        // fire — the final phase always calls it exactly once.
        const emitServerSpy = vi.spyOn(emitModule, "emitServer");

        // Second (warm) run: nothing changed, so the final full \`server.ts\`
        // this run computes is byte-identical to what's already on disk. The
        // bootstrap gate under test should skip its schema-only render
        // entirely — without it, the bootstrap phase would overwrite the full
        // content with a reduced one, and the final phase would immediately
        // write it back, touching disk twice for no observable change.
        runCodegen({ lint: false, projectRoot: workdir });

        expect(emitServerSpy).toHaveBeenCalledTimes(1);

        emitServerSpy.mockRestore();
    });
});
