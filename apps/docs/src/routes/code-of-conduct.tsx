import { createFileRoute } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";

import ContentPage from "@/components/sections/content-page";
// Compiled to a component at build time by the fumadocs-mdx Vite plugin. Compiling
// at request time and running the result needs `new Function`, which workerd
// forbids, so the page would answer 500 on the Worker.
import CodeOfConduct from "@/content/code-of-conduct.md";
import { createSeoHead } from "@/lib/seo";

const RouteComponent = () => (
    <ContentPage>
        <CodeOfConduct components={defaultMdxComponents} />
    </ContentPage>
);

export const Route = createFileRoute("/code-of-conduct")({
    component: RouteComponent,
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
