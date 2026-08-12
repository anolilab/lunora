import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A split page header: message on the left, a product visual running off the
 * right edge of the viewport.
 *
 * The left column's content lines up with the page shell while the right column
 * bleeds. That is done with `padding-left: max(gutter, (100vw - shell) / 2)`
 * rather than by nesting a Shell: a Shell would cap the whole row at the shell
 * width and there would be nothing left to bleed with. The same expression is
 * what the shell's own centring resolves to, so the two agree at every width
 * without either knowing about the other.
 *
 * Below `lg` the visual moves under the copy and the bleed stops, because a
 * half-visible screenshot on a phone is a cropped screenshot, not a composition.
 */

const SplitHeader: FC<{
    /** The message column: eyebrow, headline, actions, footnote. */
    children: ReactNode;
    className?: string;
    /** Runs off the right edge on `lg` and up. */
    visual: ReactNode;
}> = ({ children, className, visual }) => (
    // `pt-16` clears the fixed navbar. Without it the visual runs underneath a
    // transparent bar, and a screenshot of an application behind our own nav
    // reads as one confused interface: Studio's breadcrumb and search field sit
    // in the same band as ours.
    <header className={cn("relative border-b border-hairline bg-canvas pt-16", className)} data-nav-theme="dark">
        {/* The one atmospheric glow this view is allowed, behind the seam
            between the columns so it reads as depth rather than decoration. */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/3 w-2/3 opacity-40"
            style={{
                background: "radial-gradient(50% 60% at 20% 30%, var(--site-accent-2) 0%, transparent 70%)",
            }}
        />

        <div className="relative grid grid-cols-1 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div
                className="flex flex-col justify-center py-[clamp(4.5rem,3rem+8vw,8rem)] pr-5 lg:border-r lg:border-hairline lg:pr-14"
                style={{ paddingLeft: "max(1.25rem, calc((100vw - 72rem) / 2))" }}
            >
                {children}
            </div>

            <div className="relative min-h-[18rem] overflow-hidden border-t border-hairline lg:min-h-0 lg:border-t-0">{visual}</div>
        </div>
    </header>
);

export { SplitHeader };
