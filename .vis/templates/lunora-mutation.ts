/**
 * `vis generate lunora-mutation` — scaffold a new Lunora mutation function.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase, FILE_NAME_CASE_VALUES, formatFileName, isFileNameCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Lunora mutation in lunora/<name>.ts",
        name: "lunora-mutation",
    },
    options: {
        fileNameCase: {
            default: "camel",
            prompt: "Filename case (camel, kebab, pascal, snake) — the export stays camelCase",
            type: "enum",
            values: [...FILE_NAME_CASE_VALUES],
        },
        name: {
            prompt: "Mutation name (camelCased for the export; filename uses --fileNameCase)",
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
                    [`${fileName}.ts`]: `import { mutation, v } from "lunora/server";

/**
 * ${raw} mutation.
 *
 * Replace the args validators and the handler body with your own logic.
 * Mutations run in a transactional context; throw to abort.
 */
export const ${camel} = mutation
    .input({
        // Add your argument validators here:
        // text: v.string(),
    })
    .mutation(async ({ ctx, args }) => {
        // ctx.db: read+write database accessor
        // ctx.auth: optional caller identity
        // ctx.scheduler: schedule follow-up work
        // ctx.storage: read-only file storage
        return { ok: true, args };
    });
`,
                },
            },
        };
    },
});
