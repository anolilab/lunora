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
    <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
        {/* vertical guide lines at the container edges, full page height — matches the landing page */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
        />

        <section className="relative" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 pt-32 pb-24 lg:px-0">
                <DocsBody className="max-w-none">{children}</DocsBody>
            </div>
        </section>

        <SupportSection />
    </div>
);

export default ContentPage;
