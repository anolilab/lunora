import { Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A full-width navigation row: optional leading icon, title, optional
 * subtitle, trailing arrow. Stacked in a `LinkRowList` they form the hairline
 * separated index lists used across the docs hub.
 *
 * The arrow glyph encodes destination — `→` stays on the site, `↗` leaves it —
 * so the distinction survives without a visible "external" label.
 */

const LinkRow: FC<{
    className?: string;
    href?: string;
    icon?: ReactNode;
    subtitle?: ReactNode;
    title: ReactNode;
    to?: string;
}> = ({ className, href, icon, subtitle, title, to }) => {
    const external = Boolean(href?.startsWith("http"));

    const body = (
        <>
            {icon ? <span className="flex size-9 shrink-0 items-center justify-center bg-surface-raised text-accent [&_svg]:size-4">{icon}</span> : null}
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-body font-medium text-ink">{title}</span>
                {subtitle ? <span className="truncate text-blurb text-ink-muted">{subtitle}</span> : null}
            </span>
            {external ? (
                <ArrowUpRight className="ml-auto size-4 shrink-0 text-ink-faint transition-colors group-hover:text-accent" />
            ) : (
                <ArrowRight className="ml-auto size-4 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
            )}
        </>
    );

    const classes = cn("group flex items-center gap-4 border-b border-hairline px-1 py-4 transition-colors last:border-b-0 hover:bg-hairline", className);

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

const LinkRowList: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
    <div className={cn("flex flex-col border-t border-hairline", className)}>{children}</div>
);

export { LinkRow, LinkRowList };
