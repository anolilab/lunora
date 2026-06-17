import { ChevronLeftIcon, ChevronRightIcon, DotsHorizontalIcon } from "@radix-ui/react-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { ButtonProperties } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const Pagination = ({ className, ...properties }: React.ComponentProps<"nav">) => (
    <nav aria-label="pagination" className={cn("mx-auto flex w-full justify-center", className)} role="navigation" {...properties} />
);

Pagination.displayName = "Pagination";

const PaginationContent = ({ className, ref, ...properties }: React.ComponentProps<"ul"> & { ref?: React.RefObject<HTMLUListElement | null> }) => (
    <ul className={cn("flex flex-row items-center gap-1", className)} ref={ref} {...properties} />
);

PaginationContent.displayName = "PaginationContent";

const PaginationItem = ({ className, ref, ...properties }: React.ComponentProps<"li"> & { ref?: React.RefObject<HTMLLIElement | null> }) => (
    <li className={cn("", className)} ref={ref} {...properties} />
);

PaginationItem.displayName = "PaginationItem";

type PaginationLinkProperties = Pick<ButtonProperties, "size"> &
    React.ComponentProps<typeof Link> & {
        isActive?: boolean;
    };

const PaginationLink = ({ className, isActive, size = "icon", ...properties }: PaginationLinkProperties) => (
    <Link
        aria-current={isActive ? "page" : undefined}
        className={cn(
            buttonVariants({
                size,
                variant: isActive ? "outline" : "ghost",
            }),
            {
                "text-white": isActive,
            },
            className,
        )}
        {...properties}
    />
);

PaginationLink.displayName = "PaginationLink";

const PaginationPrevious = ({ className, ...properties }: Omit<React.ComponentProps<typeof PaginationLink>, "size">) => (
    <PaginationLink aria-label="Go to previous page" className={cn("gap-1 pl-2.5", className)} size="default" {...properties}>
        <ChevronLeftIcon className="h-4 w-4" />
        <span>Previous</span>
    </PaginationLink>
);

PaginationPrevious.displayName = "PaginationPrevious";

const PaginationNext = ({ className, ...properties }: Omit<React.ComponentProps<typeof PaginationLink>, "size">) => (
    <PaginationLink aria-label="Go to next page" className={cn("gap-1 pr-2.5", className)} size="default" {...properties}>
        <span>Next</span>
        <ChevronRightIcon className="h-4 w-4" />
    </PaginationLink>
);

PaginationNext.displayName = "PaginationNext";

const PaginationEllipsis = ({ className, ...properties }: React.ComponentProps<"span">) => (
    <span aria-hidden className={cn("flex h-9 w-9 items-center justify-center", className)} {...properties}>
        <DotsHorizontalIcon className="h-4 w-4" />
        <span className="sr-only">More pages</span>
    </span>
);

PaginationEllipsis.displayName = "PaginationEllipsis";

export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious };
