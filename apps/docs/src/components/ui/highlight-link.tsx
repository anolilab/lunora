import type { CreateLinkProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import type { ClassValue } from "clsx";
import type { AnchorHTMLAttributes, FC, PropsWithChildren, ReactNode } from "react";

import { cn } from "@/lib/utils";

type SharedProperties = {
    className?: ClassValue;
    icon?: ReactNode;
    mode?: "dark" | "light";
};

type InternalLinkProperties = CreateLinkProps & SharedProperties;

type ExternalLinkProperties = AnchorHTMLAttributes<HTMLAnchorElement> &
    SharedProperties & {
        href: string;
    };

const sharedClassName = (mode: "dark" | "light", className?: ClassValue) =>
    cn(
        "group border-background/10 relative block w-full overflow-hidden border border-l-2 p-5 transition duration-700 before:absolute before:top-0 before:right-0 before:bottom-0 before:left-0 before:-translate-x-full before:transition before:duration-500 hover:before:translate-x-0",
        {
            "border-l-black text-black hover:border-black hover:text-white hover:before:bg-black": mode === "light",
            "border-l-white text-white hover:border-white hover:text-black hover:before:bg-white": mode === "dark",
        },
        className,
    );

const InnerContent: FC<PropsWithChildren<{ icon?: ReactNode }>> = ({ children, icon }) => (
    <div className="relative z-10 flex flex-row gap-4">
        {children}
        {icon && <div className="grow" />}
        {icon}
    </div>
);

const HighlightLink: FC<PropsWithChildren<ExternalLinkProperties | InternalLinkProperties>> = ({
    children,
    className,
    icon,
    mode = "light",
    ...properties
}) => {
    if ("href" in properties) {
        const { href, ...rest } = properties as ExternalLinkProperties;

        return (
            <a {...rest} className={sharedClassName(mode, className)} href={href}>
                <InnerContent icon={icon}>{children}</InnerContent>
            </a>
        );
    }

    return (
        <Link {...(properties as CreateLinkProps)} className={sharedClassName(mode, className)}>
            <InnerContent icon={icon}>{children}</InnerContent>
        </Link>
    );
};

export default HighlightLink;
