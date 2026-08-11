import type { ComponentPropsWithoutRef, FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Layout primitives. These carry the whole spatial system: nothing else in the
 * app should set a page gutter, a section rhythm, or a max width.
 *
 * The system is a 12-column grid inside a capped shell, separated by 1px
 * hairlines rather than gaps or shadows. Gutters and section rhythm are fluid
 * (they read `--site-gutter` / `--site-section-gap`); the type scale is not.
 */

/** Capped, gutter-padded container. Every band's content sits in one of these. */
const Shell: FC<ComponentPropsWithoutRef<"div">> = ({ children, className, ...rest }) => (
    // eslint-disable-next-line react/jsx-props-no-spreading -- forwarding native div attributes
    <div className={cn("mx-auto w-full max-w-shell px-gutter", className)} {...rest}>
        {children}
    </div>
);

/**
 * A full-bleed horizontal band. `tone` picks the surface; `divided` draws the
 * hairline that separates it from the band above.
 *
 * Vertical rhythm is owned here so pages never hand-tune `py-*` — that is how
 * a page ends up with eleven slightly different section paddings.
 */
const Section: FC<{
    children: ReactNode;
    className?: string;
    /** Suppress the standard vertical rhythm (for edge-to-edge visuals). */
    flush?: boolean;
    id?: string;
    tone?: "canvas" | "deep" | "surface";
}> = ({ children, className, flush = false, id, tone = "canvas" }) => (
    <section
        className={cn(
            "relative border-t border-hairline",
            tone === "canvas" && "bg-canvas",
            tone === "deep" && "bg-canvas-deep",
            tone === "surface" && "bg-surface",
            !flush && "py-section",
            className,
        )}
        data-nav-theme="dark"
        id={id}
    >
        {children}
    </section>
);

/**
 * Mono uppercase micro-label. Two tracking steps: `kicker` (0.12em) for labels
 * that sit beside content, `micro` (0.18em) for the smallest standalone meta.
 */
const Kicker: FC<{
    children: ReactNode;
    className?: string;
    size?: "kicker" | "micro";
    tone?: "accent" | "faint" | "muted";
}> = ({ children, className, size = "kicker", tone = "faint" }) => (
    <span
        className={cn(
            "font-mono uppercase",
            size === "kicker" ? "text-kicker" : "text-micro",
            tone === "accent" && "text-accent",
            tone === "muted" && "text-ink-muted",
            tone === "faint" && "text-ink-faint",
            className,
        )}
    >
        {children}
    </span>
);

/**
 * The numbered section header: an index in the left column, the title beside
 * it, and an optional right-aligned note. Collapses to a single column below
 * `md` — the note reads as a subtitle there rather than being dropped.
 *
 * `index` is a string ("01") rather than a number so the caller controls
 * zero-padding; auto-numbering would couple the header to its page order.
 */
const SectionHeader: FC<{
    children?: ReactNode;
    className?: string;
    index?: string;
    note?: ReactNode;
    title: ReactNode;
}> = ({ children, className, index, note, title }) => (
    <header className={cn("mb-[clamp(2.5rem,1.5rem+3vw,4.5rem)] grid grid-cols-1 gap-x-col-gap gap-y-4 md:grid-cols-12", className)}>
        {index ? (
            <div className="md:col-span-1">
                <Kicker tone="accent">{index}</Kicker>
                <div className="mt-2 hidden h-px bg-hairline md:block" />
            </div>
        ) : null}
        <div className={cn("flex flex-col gap-3.5", index ? "md:col-span-7" : "md:col-span-8")}>
            <h2 className="text-h2 font-bold text-balance text-ink">{title}</h2>
            {children}
        </div>
        {note ? <p className="text-body text-ink-muted md:col-span-4 md:self-end md:text-right">{note}</p> : null}
    </header>
);

export { Kicker, Section, SectionHeader, Shell };
