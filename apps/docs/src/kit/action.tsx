import { Link } from "@tanstack/react-router";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The site's only button. Square corners, mono uppercase label, 1px border —
 * the same shape whether it renders a `<button>`, an `<a>`, or a router
 * `<Link>`, chosen from the props rather than by a `as` escape hatch.
 *
 * Deliberately separate from `components/ui/button` (shadcn): that one is a
 * rounded `<button>` on the shadcn token set for form UI, and cannot render a
 * link. Use this for navigation and marketing calls to action.
 */

const VARIANT: Record<string, string> = {
    ghost: "text-ink-muted hover:bg-hairline hover:text-ink",
    outline: "border border-hairline-strong text-ink hover:border-ink-faint hover:bg-hairline",
    primary: "bg-accent text-on-accent hover:opacity-90",
};

type ActionProps = {
    children: ReactNode;
    className?: string;
    variant?: "ghost" | "outline" | "primary";
} & ({ href: string; onClick?: never; to?: never } | { href?: never; onClick: () => void; to?: never } | { href?: never; onClick?: never; to: string });

const Action: FC<ActionProps> = ({ children, className, href, onClick, to, variant = "outline" }) => {
    const classes = cn(
        "inline-flex h-10 items-center justify-center gap-2 px-5 font-mono text-kicker uppercase transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        VARIANT[variant],
        className,
    );

    if (href) {
        // Only absolute URLs leave the site, so only they need the noreferrer
        // hardening and a new tab; in-site hrefs (hashes, /paths) stay put.
        const external = href.startsWith("http");

        return (
            <a className={classes} href={href} rel={external ? "noopener noreferrer" : undefined} target={external ? "_blank" : undefined}>
                {children}
            </a>
        );
    }

    if (to) {
        return (
            <Link className={classes} to={to}>
                {children}
            </Link>
        );
    }

    return (
        <button className={classes} onClick={onClick} type="button">
            {children}
        </button>
    );
};

export { Action };
export type { ActionProps };
