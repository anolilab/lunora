import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { createSeoHead } from "@/lib/seo";
import Changelog from "@/pages/changelog";

// The changelogs are parsed into structured releases on the server rather than
// compiled as MDX: the page renders a feed of versions, dates and grouped notes,
// and one compiled document per package cannot be sorted, filtered or merged.
const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
    const { listFeed } = await import("@/lib/changelog-source");

    return listFeed();
});

const RouteComponent = () => <Changelog feed={Route.useLoaderData()} />;

export const Route = createFileRoute("/changelog")({
    component: RouteComponent,
    loader: () => loadFeed(),
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
