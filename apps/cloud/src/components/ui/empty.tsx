import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * shadcn/ui Empty — the empty-state block `section-ui`'s `SectionEmpty` wraps.
 *
 * Plain elements rather than a primitive: an empty state is presentational, with no
 * focus management or portal to delegate. Written here because `packages/studio`'s
 * component set predates this block, so there was nothing to copy.
 */
function Empty({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return (
        <div
            className={cn(
                "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border border-dashed p-6 text-center text-balance",
                className,
            )}
            data-slot="empty"
            {...props}
        />
    );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div className={cn("flex max-w-sm flex-col items-center gap-2 text-center", className)} data-slot="empty-header" {...props} />;
}

const emptyMediaVariants = cva("flex shrink-0 items-center justify-center mb-2 [&_svg]:pointer-events-none", {
    defaultVariants: { variant: "default" },
    variants: {
        variant: {
            default: "bg-transparent",
            icon: "bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg:not([class*='size-'])]:size-6",
        },
    },
});

function EmptyMedia({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>): React.ReactElement {
    return <div className={cn(emptyMediaVariants({ variant }), className)} data-slot="empty-media" data-variant={variant} {...props} />;
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div className={cn("text-base font-medium tracking-tight", className)} data-slot="empty-title" {...props} />;
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return (
        <div
            className={cn("text-muted-foreground [&>a]:hover:text-primary text-sm/relaxed [&>a]:underline [&>a]:underline-offset-4", className)}
            data-slot="empty-description"
            {...props}
        />
    );
}

export { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
