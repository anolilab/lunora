/**
 * `vis generate cirrus-action` — scaffold a new Cirrus action function.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Cirrus action in cirrus/<name>.ts",
        name: "cirrus-action",
    },
    options: {
        name: {
            prompt: "Action name (will be camelCased into the export and the filename)",
            required: true,
            type: "string",
        },
    },
    produce: ({ options }) => {
        const raw = String(options.name);
        const camel = camelCase(raw);

        return {
            files: {
                cirrus: {
                    [`${camel}.ts`]: `import { action, v } from "@cirrus/server";

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
