/**
 * `vis generate lunora-query` — scaffold a new Lunora query function.
 *
 * Replacement for the deleted `lunora new query &lt;name>` command. Writes
 * `lunora/&lt;camelCaseName>.ts` relative to --to (defaults to working dir).
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase, FILE_NAME_CASE_VALUES, formatFileName, isFileNameCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Lunora query in lunora/<name>.ts",
        name: "lunora-query",
    },
    options: {
        fileNameCase: {
            default: "camel",
            prompt: "Filename case (camel, kebab, pascal, snake) — the export stays camelCase",
            type: "enum",
            values: [...FILE_NAME_CASE_VALUES],
        },
        name: {
            prompt: "Query name (camelCased for the export; filename uses --fileNameCase)",
            required: true,
            type: "string",
        },
    },
    produce: ({ options }) => {
        const raw = String(options.name);
        const camel = camelCase(raw);
        const style = isFileNameCase(options.fileNameCase) ? options.fileNameCase : "camel";
        const fileName = formatFileName(raw, style);

        return {
            files: {
                lunora: {
                    [`${fileName}.ts`]: `import { query, v } from "lunorash/server";

/**
 * ${raw} query.
 *
 * Replace the args validators and the handler body with your own logic.
 * Run \`lunora codegen\` (or keep \`pnpm dev\` running) to regenerate the
 * typed API after you save this file.
 */
export const ${camel} = query
    .input({
        // Add your argument validators here:
        // limit: v.optional(v.number()),
    })
    .query(async ({ ctx, args }) => {
        // ctx.db: read-only database accessor
        // ctx.auth: optional caller identity
        // ctx.storage: read-only file storage
        return { ok: true, args };
    });
`,
                },
            },
            suggestions: [`Wire ${camel} into your client via the generated api.* surface.`],
        };
    },
});
