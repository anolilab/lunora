import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The hairline grid — the signature structure of the site.
 *
 * Cells are separated by real 1px lines rather than whitespace: the container
 * paints `--site-hairline` and a 1px gap lets it through between opaque cells.
 * That is why cells must stay opaque; a translucent cell background reveals the
 * hairline colour across its whole face instead of only at the seams.
 */

const COLUMN_CLASS: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
};

const HairlineGrid: FC<{
    children: ReactNode;
    className?: string;
    /** Columns at the widest breakpoint. Always 1 column on small screens. */
    columns?: 2 | 3 | 4;
}> = ({ children, className, columns = 3 }) => (
    <div className={cn("grid grid-cols-1 gap-px border border-hairline bg-hairline", COLUMN_CLASS[columns], className)}>{children}</div>
);

/**
 * One cell of a `HairlineGrid`. `highlight` flips it to the accent — used for
 * at most one cell per grid, which is what makes it read as emphasis.
 */
const GridCell: FC<{
    blurb?: ReactNode;
    children?: ReactNode;
    className?: string;
    highlight?: boolean;
    icon?: ReactNode;
    index?: string;
    title?: ReactNode;
}> = ({ blurb, children, className, highlight = false, icon, index, title }) => (
    <div className={cn("group relative flex flex-col gap-5 p-6", highlight ? "bg-accent text-on-accent" : "bg-canvas", className)}>
        {index || icon ? (
            <div className="flex items-center justify-between gap-3">
                {icon ? <span className={cn("[&_svg]:size-5", highlight ? "text-on-accent" : "text-ink-faint")}>{icon}</span> : null}
                {index ? <span className={cn("ml-auto font-mono text-kicker uppercase", highlight ? "text-on-accent/70" : "text-accent")}>{index}</span> : null}
            </div>
        ) : null}

        {title ? <h3 className={cn("text-h3 font-bold", highlight ? "text-on-accent" : "text-ink")}>{title}</h3> : null}
        {blurb ? <p className={cn("text-blurb", highlight ? "text-on-accent/75" : "text-ink-muted")}>{blurb}</p> : null}

        {children ? <div className="mt-auto">{children}</div> : null}
    </div>
);

export { GridCell, HairlineGrid };
