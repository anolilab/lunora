import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type * as PageTree from "fumadocs-core/page-tree";
import browserCollections from "fumadocs-mdx:collections/browser";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsPage } from "fumadocs-ui/page";
import { ChevronRight } from "lucide-react";
import type { CSSProperties, FC } from "react";
import { useMemo } from "react";

import JsonLd from "@/components/seo/json-ld";
import { ArticleHeader } from "@/kit/page-header";
import { relatedSlugs } from "@/lib/docs-related";
import { source } from "@/lib/docs-source";
import { createSeoHead } from "@/lib/seo";

import { NotFound } from "../../pages/not-found";

interface RelatedTopic {
    description: string;
    /** Top-level docs section, e.g. "concepts" — the row's label. */
    section: string;
    title: string;
    url: string;
}

type ServerLoaderResult = {
    description: string;
    lastModified: string | null;
    path: string;
    related: RelatedTopic[];
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

/** How many related topics the block shows. */
const RELATED_LIMIT = 6;

/**
 * The pages worth reading next.
 *
 * Ordered by `relatedSlugs`, which reads the cross-links the authors already
 * wrote, and topped up with folder siblings only when a page links nowhere —
 * 8 of the 150 pages. Siblings alone was the first rule and it paired pages
 * that share a directory and nothing else: `packages/auth` beside
 * `packages/browser`, while `concepts/schema`, which half the site links to,
 * never appeared next to any of them.
 */
const relatedTo = (slugs: string[]): RelatedTopic[] => {
    const here = slugs.join("/");

    const describe = (page: ReturnType<typeof source.getPages>[number], note?: string): RelatedTopic => {
        const data = page.data as { description?: string; title?: string };

        return {
            // The author's own gloss when there is one: "what `mask_uncovered_pii_column`
            // guards" says more about why to follow the link than the target
            // page's own summary of itself does.
            description: note ?? data.description ?? "",
            // A top-level page has no section of its own, so it labels as Docs.
            section: page.slugs.length > 1 ? (page.slugs[0] ?? "docs") : "docs",
            title: data.title ?? page.slugs.at(-1) ?? "",
            url: page.url,
        };
    };

    const pages = source.getPages();
    const bySlug = new Map(pages.map((page) => [page.slugs.join("/"), page]));

    // A link can name a page that has since moved; resolving each one and
    // dropping the misses is what stops a rename leaving a dead row behind.
    const linked = relatedSlugs(here).flatMap((entry) => {
        const page = bySlug.get(entry.slug);

        return page ? [describe(page, entry.note)] : [];
    });

    if (linked.length >= RELATED_LIMIT) {
        return linked.slice(0, RELATED_LIMIT);
    }

    const folder = slugs.slice(0, -1).join("/");
    const taken = new Set(linked.map((topic) => topic.url));
    const siblings = pages.flatMap((page) => {
        const sibling =
            page.slugs.join("/") !== here && page.slugs.length === slugs.length && page.slugs.slice(0, -1).join("/") === folder && !taken.has(page.url);

        return sibling ? [describe(page)] : [];
    });

    return [...linked, ...siblings].slice(0, RELATED_LIMIT);
};

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
            related: relatedTo(slugs),
            title: pageData.title ?? "",
            tree: source.pageTree,
        };
    });

const clientLoader = browserCollections.docs.createClientLoader({
    component({ toc, lastModified, default: MDX }: { default: any; lastModified?: string; toc: any }) {
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

    // "Docs / <section>". `slugs` is the path already joined ("concepts/schema"),
    // not an array — destructuring it yields its first *character*, which is how
    // this first rendered as "DOCS / G".
    //
    // The last segment is the page itself and is dropped: its title is the
    // heading directly beneath the trail, so keeping it would say it twice.
    const docsBreadcrumb = useMemo(() => {
        const sections = data.slugs.split("/").filter(Boolean).slice(0, -1);

        return [
            { label: "Docs", to: "/docs" },
            ...sections.map((section) => {
                return { label: section.replaceAll("-", " ") };
            }),
        ];
    }, [data.slugs]);

    return (
        <>
            <JsonLd data={articleJsonLd} />
            <JsonLd data={{ "@type": "BreadcrumbList", itemListElement: breadcrumbItems }} />
            <ArticleHeader breadcrumb={docsBreadcrumb} lead={data.description} meta="Documentation" title={data.title} />
            <DocsLayout
                containerProps={{
                    // Reserve the fixed external navbar's height (h-24) as the docs
                    // header row so content, sidebar, and TOC all sit below it. This
                    // has to track the navbar: at 4rem against a 6rem bar the sidebar
                    // stuck 32px too high and its first items sat under the nav.
                    // Page gutters: 20 / 34 / 40 / 70px as the viewport grows. Stepped rather
                    // than a clamp so the widths are the ones asked for exactly.
                    className: "bg-background px-5 sm:px-[34px] md:px-10 xl:px-[70px]",
                    style: { "--fd-header-height": "var(--site-nav-height)", "--fd-layout-width": "100%" } as CSSProperties,
                }}
                nav={{
                    enabled: false,
                }}
                searchToggle={{
                    enabled: false,
                }}
                sidebar={{
                    // Hides the desktop collapse trigger. The sidebar is the only
                    // way around a docs section, and it now shares the page's own
                    // canvas rather than being a panel — a control for folding it
                    // away reads as chrome on something that is not a panel.
                    collapsible: false,
                }}
                tabMode="navbar"
                themeSwitch={{
                    enabled: false,
                }}
                tree={tree}
            >
                <Content />
            </DocsLayout>

            {/* Outside `DocsLayout`, not inside it. That layout places its
                children into named grid areas, so an extra child lands in the
                first free one — which put this block above the article instead
                of under it. As a sibling it reads as its own band below the
                whole page, which is also where the sidebar stops mattering. */}
            <RelatedTopics topics={data.related} />
        </>
    );
};

/**
 * Lists the pages beside this one, as a numbered index under the article.
 *
 * A ruled list rather than cards: these are destinations, and a reader scanning
 * for the next page wants titles in a column, not a grid to parse. Each row
 * carries the section it belongs to, so a link out of "concepts" into
 * "packages" says so before it is followed.
 *
 * The rule is full-bleed while the content is not: a border on the shell-width
 * inner box would stop short of each edge and read as an underline on the block
 * rather than as the seam between it and the article.
 */
const RelatedTopics: FC<{ topics: RelatedTopic[] }> = ({ topics }) =>
    topics.length === 0 ? null : (
        <section className="border-t border-hairline">
            <div className="mx-auto w-full max-w-shell px-5 pt-14 pb-20 sm:px-[34px] md:px-10 xl:px-0">
                <div className="flex items-baseline justify-between gap-6">
                    <h2 className="text-h2 font-bold tracking-tight text-ink">Related topics</h2>
                    <span className="font-mono text-[11px] tracking-[0.09em] whitespace-nowrap text-ink-faint uppercase">
                        {String(topics.length).padStart(2, "0")} topics
                    </span>
                </div>

                <ul className="mt-8">
                    {topics.map((topic, index) => (
                        <li key={topic.url}>
                            <Link
                                className="group grid grid-cols-[2.5rem_minmax(0,1fr)_1rem] items-baseline gap-x-4 gap-y-1 border-t border-hairline py-5 transition-colors last:border-b hover:bg-wash md:grid-cols-[2.5rem_6rem_minmax(0,15rem)_minmax(0,1fr)_1rem] md:gap-x-6"
                                to={topic.url}
                            >
                                <span className="font-mono text-xs text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
                                <span className="col-start-2 font-mono text-[10px] tracking-[0.18em] text-accent uppercase md:col-start-auto">
                                    {topic.section}
                                </span>
                                <span className="col-start-2 text-sm font-medium text-ink md:col-start-auto">{topic.title}</span>
                                {topic.description ? (
                                    <span className="col-start-2 text-sm leading-relaxed text-ink-faint md:col-start-auto">{topic.description}</span>
                                ) : (
                                    <span aria-hidden="true" className="hidden md:block" />
                                )}
                                <ChevronRight
                                    aria-hidden="true"
                                    className="col-start-3 size-4 self-center justify-self-end text-ink-faint transition-transform group-hover:translate-x-0.5 md:col-start-auto"
                                />
                            </Link>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );

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
