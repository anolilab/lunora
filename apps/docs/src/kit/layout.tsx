import { Link } from "@tanstack/react-router";
import { MoveRight } from "lucide-react";
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

/**
 * Capped, gutter-padded container. Every band's content sits in one of these,
 * including the navbar, so the bar and the sections under it share one edge.
 *
 * Padding falls away at `lg`, where content meets the page's vertical guide
 * lines exactly. A full-width grid inside a Shell therefore drops its own side
 * borders at `lg` (`lg:border-x-0`) or it doubles those lines.
 *
 * A grid that needs edge-to-edge dividers goes *inside* a Shell rather than
 * being one: put the padding on the Shell and the grid within it, or the outer
 * cells sit inside the padding while the grid's own border sits outside it and
 * their dividers stop short of the edge they should meet.
 */
const Shell: FC<ComponentPropsWithoutRef<"div">> = ({ children, className, ...rest }) => (
    // eslint-disable-next-line react/jsx-props-no-spreading -- forwarding native div attributes
    <div className={cn("mx-auto w-full max-w-shell px-5 lg:px-0", className)} {...rest}>
        {children}
    </div>
);

/**
 * A full-bleed horizontal band. `tone` picks the surface.
 *
 * Deliberately applies no vertical padding. The hatched spacer between bands
 * carries the rhythm, and a band that pads itself as well doubles it: a section
 * gap became the spacer plus twice the padding, which is what left the page
 * with a screen of empty canvas between every two bands.
 *
 * If a band needs breathing room beyond the spacer, that is a property of that
 * band's content and belongs on the content, not on every section on the site.
 */
const Section: FC<{
    children: ReactNode;
    className?: string;
    id?: string;
    tone?: "canvas" | "deep" | "surface";
}> = ({ children, className, id, tone = "canvas" }) => (
    <section
        className={cn(
            "relative border-t border-hairline",
            tone === "canvas" && "bg-canvas",
            tone === "deep" && "bg-canvas-deep",
            tone === "surface" && "bg-surface",
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
 * The numbered section header.
 *
 * Left column stacks the index over a category label — the label says what
 * kind of thing the section is, which the title itself rarely does. The copy
 * column carries the title and an optional lead paragraph. `note` adds a
 * right-aligned aside, used on index pages where the section needs a pointer
 * ("Start with the adapter built for your project") more than a lead.
 *
 * `action` puts a link in the right column instead of a note: use it when the
 * section is a sample of something larger and the reader should be able to
 * reach the whole of it ("Browse all docs"). A section that is complete in
 * itself takes a note, or neither.
 *
 * `index` is a string ("01") rather than a number so the caller controls
 * zero-padding; auto-numbering would couple the header to its page order.
 */
const SectionHeader: FC<{
    /** Trailing link to the fuller version of what this section samples. */
    action?: { label: string; to: string };
    children?: ReactNode;
    className?: string;
    index?: string;
    /** Category label under the index — "Animation library", "Add-ons". */
    label?: string;
    note?: ReactNode;
    title: ReactNode;
}> = ({ action, children, className, index, label, note, title }) => (
    <header className={cn("mb-[clamp(2.5rem,1.5rem+3vw,4.5rem)] grid grid-cols-1 gap-x-col-gap gap-y-5 md:grid-cols-12", className)}>
        {index || label ? (
            <div className="flex flex-col gap-1.5 md:col-span-2">
                {index ? <Kicker tone="accent">{index}</Kicker> : null}
                {label ? <Kicker tone="faint">{label}</Kicker> : null}
            </div>
        ) : null}
        <div className={cn("flex flex-col gap-3.5", index || label ? "md:col-span-6" : "md:col-span-8")}>
            <h2 className="text-h2 font-bold text-balance text-ink">{title}</h2>
            {children}
        </div>
        {note || action ? (
            <div className="flex flex-col items-start gap-3 md:col-span-4 md:items-end md:self-end">
                {note ? <p className="text-body text-ink-muted md:text-right">{note}</p> : null}
                {action ? (
                    <Link
                        className="group inline-flex min-h-[24px] items-center gap-2 py-1 font-mono text-kicker uppercase text-ink transition-colors hover:text-accent"
                        to={action.to}
                    >
                        {action.label}
                        <MoveRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                ) : null}
            </div>
        ) : null}
    </header>
);

export { Kicker, Section, SectionHeader, Shell };
