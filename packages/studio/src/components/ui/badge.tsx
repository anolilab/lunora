import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const badgeVariants: (props?: {
    variant?: "default" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "success" | "warning" | "info" | null;
}) => string = cva(
    "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-none border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
    {
        variants: {
            // Semantic status variants get the Lunora "instrument-panel" label
            // treatment (Geist Mono, ALL CAPS, tracked). Content variants
            // (default/secondary/outline/…) stay normal-case so badges carrying
            // proper nouns — table names, usernames — read correctly.
            variant: {
                default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
                secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
                destructive:
                    "bg-destructive/10 text-destructive font-mono text-[11px] tracking-wide uppercase focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
                outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
                ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
                link: "text-primary underline-offset-4 hover:underline",
                success: "bg-success/10 text-success font-mono text-[11px] tracking-wide uppercase [a]:hover:bg-success/15 dark:bg-success/15",
                warning: "bg-warning/10 text-warning font-mono text-[11px] tracking-wide uppercase [a]:hover:bg-warning/15 dark:bg-warning/15",
                info: "bg-info/10 text-info font-mono text-[11px] tracking-wide uppercase [a]:hover:bg-info/15 dark:bg-info/15",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

function Badge({
    className,
    variant = "default",
    render,
    ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>): React.ReactElement {
    return useRender({
        defaultTagName: "span",
        props: mergeProps<"span">(
            {
                className: cn(badgeVariants({ variant }), className),
            },
            props,
        ),
        render,
        state: {
            slot: "badge",
            variant,
        },
    });
}

// react-doctor-disable-next-line react-doctor/only-export-components -- the studio ships one feature per file — panel plus the helpers and types it owns — and this rule wants each of those split in two purely so Fast Refresh keeps component state during dev; a package-wide file split is not worth an HMR-only gain
export { Badge, badgeVariants };
