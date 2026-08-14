import { useRouterState } from "@tanstack/react-router";
import { DocsBody } from "fumadocs-ui/page";
import type { FC, PropsWithChildren } from "react";

import { Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import { SITE_NAME } from "@/lib/seo";

/**
 * Shared frame for prose content pages (imprint, privacy, code of conduct, …).
 *
 * Opens with the same `ArticleHeader` every other non-landing page uses, so the
 * legal pages are not the one corner of the site with their own hero.
 *
 * The header names the page from the route's own head tags rather than from a
 * prop, because these pages pass none: each route states its title and
 * description once, in `createSeoHead`. That is also the only source that
 * covers the code-of-conduct page, whose title lives inside compiled markdown
 * this component cannot inspect. `findLast` matches the precedence
 * `HeadContent` applies — the deepest match wins.
 */
const ContentPage: FC<PropsWithChildren> = ({ children }) => {
    const title = useRouterState({
        select: (state) =>
            // `createSeoHead` suffixes the document title with the site name; the
            // header sits under a breadcrumb that already says "Lunora".
            (state.matches.flatMap((match) => match.meta ?? []).findLast((tag) => tag?.title !== undefined)?.title ?? SITE_NAME).replace(` - ${SITE_NAME}`, ""),
    });

    const lead = useRouterState({
        select: (state) => state.matches.flatMap((match) => match.meta ?? []).findLast((tag) => tag?.name === "description")?.content,
    });

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <ArticleHeader breadcrumb={[{ label: SITE_NAME, to: "/" }, { label: title }]} lead={lead} title={title} />

            <section className="relative" data-nav-theme="dark">
                {/* The Shell aligns this band's gutter with every other band on the
                    site; the inner cap is what keeps running legal text at a
                    readable measure rather than stretching it to the full shell.

                    The document's own leading `<h1>` is dropped: the header now
                    carries it, and two copies of the same title one above the
                    other is both a visual duplicate and a second page-level
                    heading. Hiding it in CSS covers the MDX page too, where the
                    heading is not a child this component can filter. */}
                <Shell className="pt-16 pb-24">
                    <DocsBody className="max-w-3xl [&>h1:first-child]:hidden">{children}</DocsBody>
                </Shell>
            </section>
        </div>
    );
};

export default ContentPage;
