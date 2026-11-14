import { createCompiler } from "@fumadocs/mdx-remote";
import { executeMdxSync } from "@fumadocs/mdx-remote/client";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import defaultMdxComponents from "fumadocs-ui/mdx";

import ContentPage from "@/components/sections/content-page";
// Bundle the markdown at build time via Vite's `?raw` loader. The Worker has no
// access to the source tree at request time, so a readFileSync would fail.
import codeOfConductSource from "@/content/code-of-conduct.md?raw";
import { createSeoHead } from "@/lib/seo";

const compiler = createCompiler({
    development: false,
});

const loader = createServerFn({
    method: "GET",
})
    .middleware([staticFunctionMiddleware])
    .handler(async () => {
        const result = await compiler.compile({ source: codeOfConductSource });

        return {
            compiled: result.compiled,
        };
    });

const RouteComponent = () => {
    const { compiled } = Route.useLoaderData();
    const { default: MdxContent } = executeMdxSync(compiled);

    return (
        <ContentPage>
            <MdxContent components={defaultMdxComponents} />
        </ContentPage>
    );
};

export const Route = createFileRoute("/code-of-conduct")({
    component: RouteComponent,
    loader: () => loader(),
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Lunora community code of conduct based on the Contributor Covenant, outlining our standards for an inclusive and welcoming environment.",
                path: "/code-of-conduct",
                title: "Code of Conduct",
            }),
        };
    },
});
