import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The hairline grid — the signature structure of the site.
 *
 * Cells are separated by real 1px lines rather than whitespace: the container
 * paints `--site-hairline` and a 1px gap lets it through between opaque cells.
 * That is why cells must stay opaque; a translucent cell background reveals the
 * hairline colour across its whole face instead of only at the seams. It is
 * also why a cell must be the grid's *direct* child — wrap one in a
 * transparent animation wrapper and the wrapper becomes the grid item.
 */

const COLUMN_CLASS: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-5",
};

const HairlineGrid: FC<{
    children: ReactNode;
    className?: string;
    /** Columns at the widest breakpoint. Always 1 column on small screens. */
    columns?: 2 | 3 | 4 | 5;
}> = ({ children, className, columns = 3 }) => <div className={cn("grid grid-cols-1 gap-px bg-hairline", COLUMN_CLASS[columns], className)}>{children}</div>;

/**
 * The cell heading, wrapped in whichever link the caller asked for (router
 * link, external anchor, or none). Split out of `GridCell` so the cell body
 * stays one straight-line render instead of branching three ways inline.
 */
const CellTitle: FC<{ children: ReactNode; highlight: boolean; href?: string; to?: string }> = ({ children, highlight, href, to }) => {
    const body = (
        <>
            <span>{children}</span>
            {to || href ? (
                <ArrowUpRight
                    className={cn(
                        "size-4 shrink-0 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100",
                        highlight ? "text-on-accent" : "text-ink",
                    )}
                />
            ) : null}
        </>
    );

    const linkClass = "flex items-start justify-between gap-2";

    if (to) {
        return (
            <Link className={linkClass} to={to}>
                {body}
            </Link>
        );
    }

    if (href) {
        return (
            <a className={linkClass} href={href} rel="noopener noreferrer" target="_blank">
                {body}
            </a>
        );
    }

    return body;
};

/**
 * One cell of a `HairlineGrid`.
 *
 * Reading order top to bottom: the visual stage, then the title (with a hover
 * arrow when it links somewhere), the blurb, and an optional mono readout
 * pinned to the bottom. The stage leads because these cells sell a capability —
 * the picture does that faster than the heading does.
 *
 * `highlight` flips the cell to the accent. Use it on at most one cell per
 * grid; a second one stops it reading as emphasis.
 */
const GridCell: FC<{
    blurb?: ReactNode;
    /** Extra content below the blurb — a feature list, a nested action. */
    children?: ReactNode;
    className?: string;
    highlight?: boolean;
    href?: string;
    /** Small mark shown above the title. For cells with no full `stage`. */
    icon?: ReactNode;
    /** Mono line pinned to the bottom — a type signature, a value, a result. */
    readout?: ReactNode;
    /** The visual area at the top of the cell. */
    stage?: ReactNode;
    title?: ReactNode;
    to?: string;
}> = ({ blurb, children, className, highlight = false, href, icon, readout, stage, title, to }) => {
    // Resolve the palette once. Threading `highlight ?` through every slot
    // instead puts eight independent branches in one render, which is both
    // harder to read and easy to get inconsistent when a slot is added.
    const tone = highlight
        ? {
              blurb: "text-on-accent/75",
              cell: "bg-accent text-on-accent",
              edge: "border-on-accent/15",
              icon: "text-on-accent",
              readout: "text-on-accent/60",
              title: "text-on-accent",
          }
        : {
              blurb: "text-ink-muted",
              cell: "bg-canvas",
              edge: "border-hairline",
              icon: "text-ink-faint",
              readout: "text-ink-faint",
              title: "text-ink",
          };

    return (
        <article className={cn("group relative flex flex-col", tone.cell, className)}>
            {stage ? (
                <div aria-hidden="true" className={cn("relative overflow-hidden border-b", tone.edge)}>
                    {stage}
                </div>
            ) : null}

            <div className="flex flex-1 flex-col gap-3 p-6">
                {icon ? (
                    <div className="flex items-center justify-between gap-3">
                        <span className={cn("flex items-center gap-2 [&_svg]:size-5", tone.icon)}>{icon}</span>
                    </div>
                ) : null}

                {title ? (
                    <h3 className={cn("text-h3 font-bold", tone.title)}>
                        <CellTitle highlight={highlight} href={href} to={to}>
                            {title}
                        </CellTitle>
                    </h3>
                ) : null}

                {blurb ? <p className={cn("text-blurb", tone.blurb)}>{blurb}</p> : null}

                {children}

                {readout ? <div className={cn("mt-auto pt-3 font-mono text-micro tracking-normal", tone.readout)}>{readout}</div> : null}
            </div>
        </article>
    );
};

/**
 * The rule grid: a row of `Label` + one sentence. Used directly under a page
 * header to state what the thing is, before any section does.
 */
const RuleGrid: FC<{
    className?: string;
    columns?: 2 | 3 | 4 | 5;
    items: { label: string; text: ReactNode }[];
}> = ({ className, columns = 5, items }) => (
    <dl className={cn("grid grid-cols-1 gap-px bg-hairline", COLUMN_CLASS[columns], className)}>
        {items.map((item) => (
            <div className="flex flex-col gap-2 bg-canvas p-[1.375rem]" key={item.label}>
                <dt className="font-mono text-kicker uppercase text-accent">{item.label}</dt>
                <dd className="text-blurb text-ink-muted">{item.text}</dd>
            </div>
        ))}
    </dl>
);

export { GridCell, HairlineGrid, RuleGrid };
