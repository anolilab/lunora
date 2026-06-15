/**
 * `vis generate lunora-action` — scaffold a new Lunora action function.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase, FILE_NAME_CASE_VALUES, formatFileName, isFileNameCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Lunora action in lunora/<name>.ts",
        name: "lunora-action",
    },
    options: {
        fileNameCase: {
            default: "camel",
            prompt: "Filename case (camel, kebab, pascal, snake) — the export stays camelCase",
            type: "enum",
            values: [...FILE_NAME_CASE_VALUES],
        },
        name: {
            prompt: "Action name (camelCased for the export; filename uses --fileNameCase)",
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
                    [`${fileName}.ts`]: `import { action, v } from "@lunora/server";

/**
 * ${raw} action.
 *
 * Actions run outside the transactional database context — use them when
 * you need to call third-party APIs or run non-deterministic logic. To
 * read or write data, call \`ctx.runQuery\` / \`ctx.runMutation\`.
 */
export const ${camel} = action({
    args: {
        // Add your argument validators here:
    },
    handler: async (ctx, args) => {
        // ctx.runQuery(api.<file>.<query>, { ... })
        // ctx.runMutation(api.<file>.<mutation>, { ... })
        // ctx.auth, ctx.scheduler, ctx.storage
        return { ok: true, args };
    },
});
`,
                },
            },
        };
    },
});
