import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type * as PageTree from "fumadocs-core/page-tree";
import browserCollections from "fumadocs-mdx:collections/browser";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { useMemo } from "react";

import JsonLd from "@/components/seo/json-ld";
import { source } from "@/lib/docs-source";
import { createSeoHead } from "@/lib/seo";

import SupportSection from "../../pages/home/sections/support";
import { NotFound } from "../../pages/not-found";

type ServerLoaderResult = {
    description: string;
    lastModified: string | null;
    path: string;
    title: string;
    tree: PageTree.Root;
} | null;

type LoaderData = NonNullable<ServerLoaderResult> & { slugs: string };

export const Route = createFileRoute("/docs/$")({
    component: () => <Page />,
    loader: async ({ params }): Promise<LoaderData> => {
        const slugs = params._splat?.split("/") ?? [];
        const data = await serverLoader({ data: slugs });

        if (!data?.path) {
            throw notFound();
        }

        await clientLoader.preload(data.path);

        return { ...data, slugs: slugs.join("/") };
    },
    notFoundComponent: (props) => <NotFound {...props}>The documentation page you're looking for doesn't exist or may have been moved.</NotFound>,
    head: ({ loaderData }) => {
        if (!loaderData?.title) {
            return {};
        }

        return {
            ...createSeoHead({
                description: loaderData.description || `Documentation for ${loaderData.title} - Lunora`,
                ogType: "article",
                path: `/docs/${loaderData.slugs}`,
                title: loaderData.title,
            }),
        };
    },
});

const serverLoader = createServerFn({
    method: "GET",
    // `tree: PageTree.Root` carries `ReactNode` icons that aren't JSON-serializable;
    // skip the strict output check rather than reshape the framework's type.
    strict: { output: false },
})
    .inputValidator((slugs: string[]) => slugs)
    .handler(async ({ data: slugs }) => {
        const page = source.getPage(slugs);

        if (!page) {
            return null;
        }

        const pageData = page.data as { description?: string; lastModified?: Date; title?: string };

        return {
            description: pageData.description ?? "",
            lastModified: pageData.lastModified ? pageData.lastModified.toISOString() : null,
            path: page.path,
            title: pageData.title ?? "",
            tree: source.pageTree,
        };
    });

const clientLoader = browserCollections.docs.createClientLoader({
    component({ toc, frontmatter, lastModified, default: MDX }: { default: any; frontmatter: any; lastModified?: string; toc: any }) {
        return (
            <DocsPage
                breadcrumb={{ includePage: true, includeRoot: true }}
                editOnGithub={{
                    owner: "anolilab",
                    repo: "lunora",
                    sha: "alpha",
                    path: `apps/docs/src/content/docs`,
                }}
                footer={{
                    enabled: false,
                }}
                full
                tableOfContent={{
                    enabled: true,
                    style: "clerk",
                }}
                toc={toc}
            >
                <DocsTitle>{frontmatter.title}</DocsTitle>
                <DocsDescription>{frontmatter.description}</DocsDescription>
                {lastModified ? (
                    <p className="text-muted-foreground -mt-2 mb-6 text-sm">
                        Last updated:{" "}
                        <time dateTime={lastModified}>
                            {new Date(lastModified).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}
                        </time>
                    </p>
                ) : null}
                <DocsBody>
                    <MDX
                        components={{
                            ...defaultMdxComponents,
                        }}
                    />
                </DocsBody>
            </DocsPage>
        );
    },
});

const Page = () => {
    const data = Route.useLoaderData();
    const Content = clientLoader.getComponent(data.path);
    const tree = useMemo(() => transformPageTree(data.tree), [data.tree]);

    const articleJsonLd = useMemo(() => {
        const jsonLd: Record<string, unknown> = {
            "@type": "TechArticle",
            author: { "@type": "Organization", name: "Lunora", url: "https://lunora.sh" },
            description: data.description,
            headline: data.title,
            publisher: { "@type": "Organization", logo: { "@type": "ImageObject", url: "https://lunora.sh/favicon.svg" }, name: "Lunora" },
            url: `https://lunora.sh/docs/${data.slugs}`,
        };

        if (data.lastModified) {
            jsonLd.dateModified = data.lastModified;
        }

        return jsonLd;
    }, [data.title, data.description, data.slugs, data.lastModified]);

    const breadcrumbItems = useMemo(() => {
        const slugs = data.slugs.split("/").filter(Boolean);
        const items = [
            { "@type": "ListItem" as const, item: "https://lunora.sh", name: "Home", position: 1 },
            { "@type": "ListItem" as const, item: "https://lunora.sh/docs", name: "Docs", position: 2 },
        ];

        slugs.forEach((slug, index) => {
            items.push({
                "@type": "ListItem" as const,
                item: `https://lunora.sh/docs/${slugs.slice(0, index + 1).join("/")}`,
                name: slug.charAt(0).toUpperCase() + slug.slice(1).split("-").join(" "),
                position: index + 3,
            });
        });

        return items;
    }, [data.slugs]);

    return (
        <>
            <JsonLd data={articleJsonLd} />
            <JsonLd data={{ "@type": "BreadcrumbList", itemListElement: breadcrumbItems }} />
            <DocsLayout
                containerProps={{
                    className: "bg-background",
                }}
                nav={{
                    enabled: false,
                }}
                searchToggle={{
                    enabled: false,
                }}
                tabMode="navbar"
                themeSwitch={{
                    enabled: false,
                }}
                tree={tree}
            >
                <Content />
            </DocsLayout>
            <div className="relative">
                <div className="absolute inset-x-0 z-10 mt-[calc(-3/16*1rem)] flex items-end rotate-180 top-0" data-nav-theme="light">
                    <div className="mr-[calc(-1*(--spacing(8)-(--spacing(1.5))))] h-11 flex-auto bg-background" />
                    <div className="mx-auto flex w-full justify-between px-7 sm:max-w-160 md:max-w-3xl lg:max-w-5xl xl:max-w-7xl">
                        <svg aria-hidden="true" className="mb-[calc(-1/16*1rem)] w-14 flex-none overflow-visible fill-background" viewBox="0 0 56 48">
                            <path d="M 2.686 3 H -4 V 48 H 56 V 47 H 53.314 A 8 8 0 0 1 47.657 44.657 L 8.343 5.343 A 8 8 0 0 0 2.686 3 Z" />
                        </svg>
                        <svg
                            aria-hidden="true"
                            className="fill-background md:fill-dark-coal mr-0.5 mb-[calc(-1/16*1rem)] w-14 flex-none overflow-visible"
                            viewBox="0 0 56 48"
                        >
                            <path d="M 53.314 3 H 60 V 48 H 0 V 47 H 2.686 A 8 8 0 0 0 8.343 44.657 L 47.657 5.343 A 8 8 0 0 1 53.314 3 Z" />
                        </svg>
                    </div>
                    <div className="bg-background md:bg-dark-coal ml-[calc(-1*(--spacing(8)-(--spacing(1.5))))] h-11 flex-auto" />
                </div>
                <SupportSection />
            </div>
        </>
    );
};

function transformPageTree(root: PageTree.Root): PageTree.Root {
    function mapNode<T extends PageTree.Node>(item: T): T {
        if (typeof item.icon === "string") {
            item = {
                ...item,
                icon: (
                    <span
                        dangerouslySetInnerHTML={{
                            __html: item.icon,
                        }}
                    />
                ),
            };
        }

        if (item.type === "folder") {
            return {
                ...item,
                index: item.index ? mapNode(item.index) : undefined,
                children: item.children.map(mapNode),
            };
        }

        return item;
    }

    return {
        ...root,
        children: root.children.map(mapNode),
        fallback: root.fallback ? transformPageTree(root.fallback) : undefined,
    };
}
