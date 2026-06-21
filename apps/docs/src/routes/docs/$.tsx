import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type * as PageTree from "fumadocs-core/page-tree";
import browserCollections from "fumadocs-mdx:collections/browser";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { CSSProperties } from "react";
import { useMemo } from "react";

import JsonLd from "@/components/seo/json-ld";
import { source } from "@/lib/docs-source";
import { createSeoHead } from "@/lib/seo";

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
    notFoundComponent: (props) => <NotFound {...props}>The documentation page you&apos;re looking for doesn&apos;t exist or may have been moved.</NotFound>,
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
                            Step,
                            Steps,
                            Tab,
                            Tabs,
                            TypeTable,
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
                    // Reserve the fixed external navbar's height (h-16) as the docs
                    // header row so content, sidebar, and TOC all sit below it.
                    className: "bg-background",
                    style: { "--fd-header-height": "4rem", "--fd-layout-width": "100%" } as CSSProperties,
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
        </>
    );
};

const transformPageTree = (root: PageTree.Root): PageTree.Root => {
    // Returns a PageTree.Node (not the input's narrowed type): the flatten branch
    // can turn a folder into a page, so the contract is Node → Node.
    const mapNode = (node: PageTree.Node): PageTree.Node => {
        const item =
            typeof node.icon === "string"
                ? {
                      ...node,
                      icon: (
                          <span
                              // eslint-disable-next-line react/no-danger -- fumadocs page-tree icons are trusted inline SVG strings from our own content
                              dangerouslySetInnerHTML={{
                                  __html: node.icon,
                              }}
                          />
                      ),
                  }
                : node;

        if (item.type !== "folder") {
            return item;
        }

        const index = item.index ? (mapNode(item.index) as PageTree.Item) : undefined;
        const children = item.children.map((child) => mapNode(child));

        // Flatten a folder that only wraps its own index page (e.g. the
        // per-package "Server" → "@lunora/server" folders) into a single link,
        // keeping the folder's clean name. fumadocs lists the index both as
        // `index` and as a child, so they dedupe to one URL. Folders with extra
        // pages (auth) or separators/subfolders (Packages) are left untouched.
        const pages = [index, ...children].filter((entry): entry is PageTree.Item => entry?.type === "page");
        const hasNonPageChild = children.some((child) => child.type !== "page");

        if (!hasNonPageChild && new Set(pages.map((page) => page.url)).size === 1 && pages[0]) {
            return { ...pages[0], name: item.name };
        }

        return {
            ...item,
            index,
            children,
        };
    };

    return {
        ...root,
        children: root.children.map((child) => mapNode(child)),
        fallback: root.fallback ? transformPageTree(root.fallback) : undefined,
    };
};
