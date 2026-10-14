import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { vectorizeDimensionDiagnostics } from "../src/platform-target";
import { runCodegen } from "../src/run-codegen";

describe(vectorizeDimensionDiagnostics, () => {
    const indexes = [
        { dimensions: 31, name: "low" },
        { dimensions: 32, name: "min" },
        { dimensions: 1536, name: "max" },
        { dimensions: 1537, name: "high" },
        { dimensions: 768.5, name: "fractional" },
        { name: "unset" },
    ];

    it("flags dimensions outside Vectorize's integer 32-1536 range, as a warning", () => {
        expect.assertions(2);

        const diagnostics = vectorizeDimensionDiagnostics("cloudflare", indexes);

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toStrictEqual([
            expect.stringContaining('"low"'),
            expect.stringContaining('"high"'),
            expect.stringContaining('"fractional"'),
        ]);
        expect(diagnostics[0]).toMatchObject({ level: "warn", name: "platform_vector_dimensions_out_of_range" });
    });

    it("stays silent off the cloudflare target", () => {
        expect.assertions(1);

        expect(vectorizeDimensionDiagnostics("node", indexes)).toStrictEqual([]);
    });
});

describe("vectorize dimensions, through runCodegen on the default cloudflare target", () => {
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vectorize-dimensions-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const flaggedMessages = (schemaSource: string): string[] => {
        writeFileSync(join(workdir, "lunora", "schema.ts"), schemaSource, "utf8");

        return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] })
            .platformDiagnostics.filter((diagnostic) => diagnostic.name === "platform_vector_dimensions_out_of_range")
            .map((diagnostic) => diagnostic.message);
    };

    it.each([
        {
            form: "inline .vectorize()",
            indexName: "docs_search",
            schema: `defineSchema({ docs: defineTable({ body: v.string() }).vectorize("body", { dimensions: 3072, index: "docs_search", metric: "cosine" }) })`,
        },
        {
            form: "a standalone defineVectorIndex",
            indexName: "docs_body",
            schema: `defineSchema({ docs: defineTable({ body: v.string() }) }, { docs_body: defineVectorIndex({ dimensions: 3072, embed, metric: "cosine", source: { select: (row) => row.body, table: "docs" } }) })`,
        },
    ])("flags 3072 dimensions declared by $form", ({ indexName, schema }) => {
        expect.assertions(2);

        const messages = flaggedMessages(
            `import { defineSchema, defineTable, defineVectorIndex, v } from "@lunora/server";\n\nexport const schema = ${schema};\n`,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(`"${indexName}"`);
    });
});
