import { DocsBody } from "fumadocs-ui/page";
import type { FC, PropsWithChildren } from "react";

import SupportSection from "@/pages/home/sections/support";

/**
 * Shared frame for prose content pages (imprint, privacy, code of conduct, …).
 *
 * Mirrors the landing page: a dark, full-height container with `max-w-6xl`
 * vertical guide lines at the edges, so the trailing `SupportSection` (which
 * drops its own side borders via `lg:border-x-0`) lines up with the same
 * left/right borders the home page draws.
 */
const ContentPage: FC<PropsWithChildren> = ({ children }) => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        <section className="relative" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 pt-32 pb-24 lg:px-0">
                <DocsBody className="max-w-none">{children}</DocsBody>
            </div>
        </section>

        <SupportSection />
    </div>
);

export default ContentPage;
