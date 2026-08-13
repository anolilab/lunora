import { Link } from "@tanstack/react-router";
import { MoveRight, MoveUpRight } from "lucide-react";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A navigation destination: optional leading mark, title, optional subtitle,
 * trailing arrow.
 *
 * The arrow glyph encodes destination — `→` stays on the site, `↗` leaves it —
 * so the distinction survives without a visible "external" label.
 *
 * Rows carry no border of their own. `LinkRowList` owns the seams, because the
 * dividing edge depends on how the list is laid out (below each row when
 * stacked, beside it when in a row) and a row cannot know which it is in.
 */

const LinkRow: FC<{
    className?: string;
    href?: string;
    /** Leading mark. Brand logos keep their own colour; icons take the ink. */
    icon?: ReactNode;
    subtitle?: ReactNode;
    title: ReactNode;
    to?: string;
}> = ({ className, href, icon, subtitle, title, to }) => {
    const external = Boolean(href?.startsWith("http"));

    const body = (
        <>
            {icon ? <span className="flex size-9 shrink-0 items-center justify-center bg-surface-raised text-ink-muted [&_svg]:size-4">{icon}</span> : null}
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-body font-medium text-ink">{title}</span>
                {subtitle ? <span className="truncate text-blurb text-ink-muted">{subtitle}</span> : null}
            </span>
            {external ? (
                <MoveUpRight className="ml-auto size-4 shrink-0 text-ink-faint transition-colors group-hover:text-ink" />
            ) : (
                <MoveRight className="ml-auto size-4 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-ink" />
            )}
        </>
    );

    const classes = cn("group flex items-center gap-4 px-1 py-4 transition-colors hover:bg-hairline", className);

    if (to) {
        return (
            <Link className={classes} to={to}>
                {body}
            </Link>
        );
    }

    return (
        <a className={classes} href={href} rel={external ? "noopener noreferrer" : undefined} target={external ? "_blank" : undefined}>
            {body}
        </a>
    );
};

const ROW_COLUMNS: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * Stacks destinations and draws the seams between them.
 *
 * `column` is the index list: a rule above the first and below each row.
 * `row` sets them side by side for short labels — a runtime picker, where the
 * name is the whole content and a stacked list would waste the width.
 */
const LinkRowList: FC<{
    children: ReactNode;
    className?: string;
    /** Columns in `row` layout at the widest breakpoint. Ignored when stacked. */
    columns?: 2 | 3 | 4;
    layout?: "column" | "row";
}> = ({ children, className, columns = 3, layout = "column" }) =>
    layout === "row" ? (
        <div
            className={cn(
                "grid grid-cols-1 border-y border-hairline",
                ROW_COLUMNS[columns],
                "[&>*]:border-b [&>*]:border-hairline sm:[&>*]:border-r sm:[&>*]:border-b-0",
                "[&>*:last-child]:border-b-0 sm:[&>*:last-child]:border-r-0",
                "[&>*]:px-5",
                className,
            )}
        >
            {children}
        </div>
    ) : (
        // The last row keeps no bottom seam: a column list is closed by the
        // band's own spacer, and a trailing rule sitting just above that spacer
        // reads as two dividers rather than one.
        <div className={cn("flex flex-col border-t border-hairline", "[&>*]:border-b [&>*]:border-hairline", "[&>*:last-child]:border-b-0", className)}>
            {children}
        </div>
    );

export { LinkRow, LinkRowList };
