import { remarkImage } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";

export const docs = defineDocs({
    dir: "src/content/docs",
    docs: {
        async: true,
        postprocess: {
            includeProcessedMarkdown: true,
        },
    },
});

export default defineConfig({
    // A function, so each MDX processor (the docs collection, and plain `.md`/`.mdx`
    // imports such as blog posts) gets its own objects. Shiki writes the aliases of
    // every language it loads into the `langAlias` object it was given; a shared one
    // makes a second highlighter believe `ts` is loaded when it is not, and every
    // docs page then fails with "Language `ts` not found".
    mdxOptions: async () => ({
        remarkPlugins: [remarkImage],
        rehypeCodeOptions: {
            // Overriding rehypeCodeOptions replaces fumadocs' defaults, so the default
            // light/dark themes must be restated here to keep code-block rendering identical.
            themes: {
                dark: "github-dark",
                light: "github-light",
            },
            langAlias: {
                tera: "jinja",
            },
        },
    }),
    plugins: [lastModified()],
});
