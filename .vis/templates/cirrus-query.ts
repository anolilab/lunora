/**
 * `vis generate cirrus-query` — scaffold a new Cirrus query function.
 *
 * Replacement for the deleted `cirrus new query &lt;name>` command. Writes
 * `cirrus/&lt;camelCaseName>.ts` relative to --to (defaults to working dir).
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Cirrus query in cirrus/<name>.ts",
        name: "cirrus-query",
    },
    options: {
        name: {
            prompt: "Query name (will be camelCased into the export and the filename)",
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
                    [`${camel}.ts`]: `import { query, v } from "@cirrus/server";

/**
 * ${raw} query.
 *
 * Replace the args validators and the handler body with your own logic.
 * Run \`cirrus codegen\` (or keep \`pnpm dev\` running) to regenerate the
 * typed API after you save this file.
 */
export const ${camel} = query({
    args: {
        // Add your argument validators here:
        // limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        // ctx.db: read-only database accessor
        // ctx.auth: optional caller identity
        // ctx.storage: read-only file storage
        return { ok: true, args };
    },
});
`,
                },
            },
            suggestions: [`Wire ${camel} into your client via the generated api.* surface.`],
        };
    },
});
