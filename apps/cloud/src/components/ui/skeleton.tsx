import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div data-slot="skeleton" className={cn("animate-pulse rounded-lg bg-muted", className)} {...props} />;
}

export { Skeleton };
