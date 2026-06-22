import { createCompiler } from "@fumadocs/mdx-remote";
import { executeMdxSync } from "@fumadocs/mdx-remote/client";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { FC } from "react";
import { useMemo } from "react";

import { createSeoHead } from "@/lib/seo";
import Changelog from "@/pages/changelog";

// Changelogs are generated markdown (not MDX), so compile in `md` format —
// this keeps angle brackets / braces from commit messages literal instead of
// being parsed as JSX.
const compiler = createCompiler({ development: false, format: "md" });

const loadChangelogs = createServerFn({ method: "GET" }).handler(async () => {
    const { listChangelogs } = await import("@/lib/changelog-source");

    return Promise.all(
        listChangelogs().map(async (entry) => {
            const result = await compiler.compile({ source: entry.content });

            return { compiled: result.compiled, key: entry.key, title: entry.title };
        }),
    );
});

const RouteComponent = () => {
    const data = Route.useLoaderData();

    const items = useMemo(
        () =>
            data.map((item) => {
                const { default: MdxContent } = executeMdxSync(item.compiled);
                const Rendered: FC = () => <MdxContent components={defaultMdxComponents} />;

                return { MdxContent: Rendered, key: item.key, title: item.title };
            }),
        [data],
    );

    return <Changelog data={items} />;
};

export const Route = createFileRoute("/changelog")({
    component: RouteComponent,
    loader: () => loadChangelogs(),
    head: () => {
        return {
            ...createSeoHead({
                description: "View the latest changes, updates, and release notes for Lunora packages.",
                path: "/changelog",
                title: "Changelog",
            }),
        };
    },
});
