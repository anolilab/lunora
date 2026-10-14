/**
 * `vis generate lunora-http-route` — scaffold a new Lunora HTTP route.
 */
import { createTemplate } from "@visulima/vis/generate";

import { camelCase, FILE_NAME_CASE_VALUES, formatFileName, isFileNameCase } from "./_helpers/case.js";

export default createTemplate({
    about: {
        description: "Scaffold a new Lunora HTTP route in lunora/<name>.ts",
        name: "lunora-http-route",
    },
    options: {
        fileNameCase: {
            default: "camel",
            prompt: "Filename case (camel, kebab, pascal, snake) — the export stays camelCase",
            type: "enum",
            values: [...FILE_NAME_CASE_VALUES],
        },
        name: {
            prompt: "Route name (camelCased for the export; filename uses --fileNameCase)",
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
                    [`${fileName}.ts`]: `import { httpRoute, v } from "lunorash/server";

/**
 * ${raw} HTTP route.
 *
 * HTTP routes run as actions in the Cloudflare Worker (outside the Durable
 * Object), so they can use \`ctx.cache.purge\` and declare cache headers.
 * Enable Workers Cache in \`wrangler.jsonc\`:
 *   "cache": { "enabled": true }
 */
export const ${camel} = httpRoute
    .get("/api/${camel}")
    .searchParams({
        // Add your query validators here:
        // q: v.optional(v.string()),
    })
    // .cacheControl("public, max-age=300, stale-while-revalidate=3600")
    // .cacheTag("${camel}")
    // .vary("Accept-Encoding")
    .handler(async ({ ctx, searchParams }) => {
        // ctx.runQuery(api.<file>.<query>, { ... })
        // ctx.runMutation(api.<file>.<mutation>, { ... })
        // if (ctx.cache) {
        //     await ctx.cache.purge({ tags: ["${camel}"] });
        // }
        return { ok: true, searchParams };
    });
`,
                },
            },
            suggestions: [
                `Enable Workers Cache in wrangler.jsonc: "cache": { "enabled": true }`,
                `Uncomment .cacheControl / .cacheTag / .vary to use declarative cache headers.`,
            ],
        };
    },
});
