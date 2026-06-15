/**
 * `vis generate lunora-table` — add a new table to lunora/schema.ts.
 *
 * If schema.ts doesn't exist yet we write a fresh one from a template. If
 * it does, we use ts-morph (via `_helpers/insert-table.ts`) to AST-edit the
 * existing `defineSchema({ ... })` call so formatting + comments + trailing
 * commas survive the edit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { camelCase, isJsIdentifier } from "./_helpers/case.js";
import { insertTableIntoSchema } from "./_helpers/insert-table.js";

const freshSchema = (tableName: string): string => `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    ${tableName}: defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    }),
});
`;

export default createTemplate({
    about: {
        description: "Add a defineTable() entry to lunora/schema.ts (creates the schema if missing)",
        name: "lunora-table",
    },
    options: {
        name: {
            prompt: "Table name (will be camelCased; must be a valid JS identifier)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name);
        const tableName = camelCase(raw);

        if (!isJsIdentifier(tableName)) {
            throw new Error(`invalid table name: "${raw}" — must be a valid JS identifier`);
        }

        const schemaPath = join(builtins.dest_dir, "lunora", "schema.ts");

        if (!existsSync(schemaPath)) {
            return {
                files: { lunora: { "schema.ts": freshSchema(tableName) } },
                suggestions: [`Created lunora/schema.ts with table "${tableName}".`],
            };
        }

        const original = readFileSync(schemaPath, "utf8");
        const result = insertTableIntoSchema(original, tableName);

        if (!result.ok) {
            if (result.reason === "duplicate") {
                throw new Error(`table "${tableName}" already exists in ${schemaPath} — pick a different name.`);
            }

            if (result.reason === "non-object-argument") {
                throw new Error(`cannot edit ${schemaPath}: the defineSchema(...) call's first argument is not an object literal.`);
            }

            throw new Error(`cannot edit ${schemaPath}: no defineSchema({ ... }) call found. Re-run with a fresh schema or add the call manually.`);
        }

        return {
            files: { lunora: { "schema.ts": result.text } },
            filesMeta: { "lunora/schema.ts": { force: true } },
            suggestions: [`Added table "${tableName}" to lunora/schema.ts.`],
        };
    },
});
