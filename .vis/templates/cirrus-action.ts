/**
 * `vis generate cirrus-action` — scaffold a new Cirrus action function.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase, FILE_NAME_CASE_VALUES, formatFileName, isFileNameCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Cirrus action in cirrus/<name>.ts",
        name: "cirrus-action",
    },
    options: {
        fileNameCase: {
            choices: FILE_NAME_CASE_VALUES,
            default: "camel",
            prompt: "Filename case (camel, kebab, pascal, snake) — the export stays camelCase",
            type: "string",
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
                cirrus: {
                    [`${fileName}.ts`]: `import { action, v } from "@cirrus/server";

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
