import { createFileRoute, notFound } from "@tanstack/react-router";

import { source } from "@/lib/docs-source";
import { getLLMText } from "@/lib/get-llm-text";

export const Route = createFileRoute("/llms.mdx/docs/$")({
    server: {
        handlers: {
            async GET({ params }) {
                const slugs = params._splat?.split("/") ?? [];
                const page = source.getPage(slugs);

                if (!page) {
                    throw notFound();
                }

                return new Response(await getLLMText(page), {
                    headers: {
                        "Content-Type": "text/markdown",
                    },
                });
            },
        },
    },
});
