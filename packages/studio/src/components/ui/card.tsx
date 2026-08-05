import * as React from "react";

import { cn } from "../../lib/utils";

function Card({ className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }): React.ReactElement {
    return (
        <div
            data-slot="card"
            data-size={size}
            className={cn(
                "group/card flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card py-4 text-xs/relaxed text-card-foreground shadow-xs has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-2 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-md *:[img:last-child]:rounded-md",
                className,
            )}
            {...props}
        />
    );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return (
        <div
            data-slot="card-header"
            className={cn(
                "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-md px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
                className,
            )}
            {...props}
        />
    );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="card-title" className={cn("font-heading text-sm font-medium group-data-[size=sm]/card:text-sm", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="card-description" className={cn("text-xs/relaxed text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="card-content" className={cn("px-4 group-data-[size=sm]/card:px-3", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
