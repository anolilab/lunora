/**
 * Regression: a legitimate `v.literal(...)` whose value carries an escape, a
 * backtick (no-substitution template), or single quotes must NOT abort the whole
 * codegen run. Before the fix, `parseBuilderMember` captured the raw source text
 * (`"it\"s"`, `` `admin` ``) and `literalToType` threw an INTERNAL error because
 * `LITERAL_VALUE_RE` rejected any backslash/backtick. Now string/template
 * literals are normalized to canonical JSON at parse time and emit cleanly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions } from "../src/discover-functions";
import { emitApi } from "../src/emit";

let workdir: string;

describe("v.literal() with escapes/backticks/single-quotes in codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-literal-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("normalizes to canonical JSON and emits without throwing", () => {
        expect.assertions(6);

        writeFunction(
            "messages.ts",
            `
            import { query, v } from "@lunora/server";
            export const pick = query({
                args: {
                    a: v.literal("it\\"s"),
                    b: v.literal(\`admin\`),
                    c: v.literal('single'),
                },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        expect(result).toHaveLength(1);
        // A double-quoted string with an embedded quote → canonical JSON `"it\"s"`.
        expect(result[0]?.args.a).toEqual({ kind: "literal", literalValue: String.raw`"it\"s"` });
        // A no-substitution template literal → canonical JSON `"admin"`.
        expect(result[0]?.args.b).toEqual({ kind: "literal", literalValue: '"admin"' });
        // A single-quoted string literal → canonical JSON `"single"`.
        expect(result[0]?.args.c).toEqual({ kind: "literal", literalValue: '"single"' });

        // Emit must not throw (the pre-fix INTERNAL crash) and must carry the
        // literal types verbatim into the generated FunctionReference.
        const rendered = emitApi({ functions: result });

        expect(rendered).toContain(String.raw`"it\"s"`);
        expect(rendered).toContain('"admin"');
    });
});
