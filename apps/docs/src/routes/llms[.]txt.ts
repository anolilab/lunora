import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";

import { source } from "@/lib/docs-source";
import { siteConfig } from "~/site.config";

/**
 * Point agents at the live endpoint, not just the page index.
 *
 * `llms.txt` is the one file a coding agent reliably fetches from a docs site,
 * which makes it the right place to say "there is an MCP server here." Without
 * it the endpoint is only discoverable by reading the docs — which is precisely
 * the thing an agent is trying to avoid doing one page at a time.
 *
 * It sits *below* the H1 and the summary, because llmstxt.org fixes that order:
 * title, then a blockquote summary, then H2 sections. A section above the H1
 * makes the title look like part of the body to anything parsing structurally.
 */
const MCP_NOTICE = `## Model Context Protocol

This documentation is also served over MCP at ${siteConfig.brand.url}/mcp — an
unauthenticated Streamable HTTP endpoint exposing \`lunora_search_docs\`,
\`lunora_get_doc\` and \`lunora_list_docs\`. Prefer it over crawling these pages:
search returns the relevant sections directly.

    claude mcp add --transport http lunora-docs ${siteConfig.brand.url}/mcp

Or run \`lunora mcp install\` inside a project to wire it into your editor
alongside that project's own Lunora server.`;

/** The spec asks for a one or two sentence blockquote directly under the H1. */
const SUMMARY = `> ${siteConfig.brand.description} Open source, and currently alpha.`;

/**
 * Normalise the generated index to what llmstxt.org describes.
 *
 * fumadocs emits a flat list: one H1, then link groups introduced by a bold
 * list item rather than a heading, with site-relative hrefs. Both are fine in a
 * browser and wrong here. `llms.txt` is read *detached* from the site — pasted
 * into a prompt, fetched by an agent, chunked into a context window — and a
 * relative path has nothing to resolve against once that happens.
 */
const GROUP_LABEL = /^- \*\*(.+?)\*\*$/gm;
const RELATIVE_HREF = /\]\(\//g;
const LEADING_HEADING = /^(#\s.+\n)/;

const normalise = (index: string): string =>
    index
        // `- **Concepts**` introduces a group, so make it the heading it already is
        .replaceAll(GROUP_LABEL, "## $1")
        // site-relative hrefs cannot survive being read away from the site
        .replaceAll(RELATIVE_HREF, `](${siteConfig.brand.url}/`);

export const Route = createFileRoute("/llms.txt")({
    server: {
        handlers: {
            GET() {
                // Insert the summary and the MCP notice directly after the H1 that
                // fumadocs emits, so the file reads title → summary → sections.
                const index = normalise(llms(source).index()).replace(LEADING_HEADING, `$1\n${SUMMARY}\n\n${MCP_NOTICE}\n`);

                return new Response(index, {
                    headers: { "Content-Type": "text/plain; charset=utf-8" },
                });
            },
        },
    },
});
