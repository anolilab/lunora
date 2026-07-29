import type { ReactElement } from "react";

import { ThemeToggle } from "../components/theme-toggle";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useT } from "../i18n/i18n-context";

/**
 * The studio's top bar: sidebar toggle + breadcrumb on the left, the ⌘K search
 * affordance centred, and the theme cluster on the right. Mirrors the reference
 * dashboard header.
 *
 * A component of its own so `StudioLayoutShell` reads as the layout it is —
 * sidebar, panel, docked console — rather than fifty lines of chrome markup
 * wrapped around three of them.
 */
const StudioHeader = ({
    domain,
    onOpenCommandPalette,
    page,
}: {
    /** Localised name of the domain owning the current page — the first crumb. */
    readonly domain: string;
    readonly onOpenCommandPalette: () => void;
    /** Localised name of the current page — the second crumb. */
    readonly page: string;
}): ReactElement => {
    const t = useT();

    return (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4" data-testid="dash-app-header">
            <SidebarTrigger className="-ms-1" />
            <nav aria-label={t("Breadcrumb")} className="flex items-center gap-1.5 text-[13px]">
                <span className="text-muted-foreground">{domain}</span>
                <svg aria-hidden="true" className="size-3.5 text-muted-foreground/60" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="font-medium text-foreground">{page}</span>
            </nav>

            <button
                className="mx-auto hidden h-8 w-72 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted md:flex"
                data-testid="dash-app-search"
                onClick={onOpenCommandPalette}
                type="button"
            >
                <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                </svg>
                {t("Search…")}
                <kbd className="ms-auto rounded border border-border bg-background px-1 font-sans text-[10px] text-muted-foreground">⌘K</kbd>
            </button>

            <div className="ms-auto flex items-center gap-1.5 md:ms-0">
                <ThemeToggle />
            </div>
        </header>
    );
};

export { StudioHeader };
