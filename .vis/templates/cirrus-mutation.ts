/**
 * `vis generate cirrus-mutation` — scaffold a new Cirrus mutation function.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Cirrus mutation in cirrus/<name>.ts",
        name: "cirrus-mutation",
    },
    options: {
        name: {
            prompt: "Mutation name (will be camelCased into the export and the filename)",
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
                    [`${camel}.ts`]: `import { mutation, v } from "@cirrus/server";

/**
 * ${raw} mutation.
 *
 * Replace the args validators and the handler body with your own logic.
 * Mutations run in a transactional context; throw to abort.
 */
export const ${camel} = mutation({
    args: {
        // Add your argument validators here:
        // text: v.string(),
    },
    handler: async (ctx, args) => {
        // ctx.db: read+write database accessor
        // ctx.auth: optional caller identity
        // ctx.scheduler: schedule follow-up work
        // ctx.storage: read-only file storage
        return { ok: true, args };
    },
});
`,
                },
            },
        };
    },
});
