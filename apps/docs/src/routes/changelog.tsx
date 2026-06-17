import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Changelog from "@/pages/changelog";

export const Route = createFileRoute("/changelog")({
    component: () => <Changelog data={[]} />,
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
