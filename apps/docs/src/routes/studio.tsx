import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import StudioLanding from "@/pages/studio";

export const Route = createFileRoute("/studio")({
    component: () => <StudioLanding />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Lunora Studio is a local admin UI for your edge backend — browse your schema and data, run SQL, rewind with time travel, observe workflows, and catch issues with advisors. Ships with every Lunora app.",
                path: "/studio",
                title: "Studio",
            }),
        };
    },
});
