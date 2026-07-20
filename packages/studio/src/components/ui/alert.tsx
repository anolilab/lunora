import { cva, type VariantProps } from "class-variance-authority";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/utils";

const alertVariants: (props?: { variant?: "default" | "destructive" | "warning" | null }) => string = cva(
    "flex items-start gap-2 rounded-md border px-3 py-2 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
    {
        defaultVariants: {
            variant: "default",
        },
        variants: {
            variant: {
                default: "border-border bg-muted/40 text-foreground",
                destructive: "border-destructive/40 bg-destructive/5 text-destructive",
                warning: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
            },
        },
    },
);

interface AlertProps extends VariantProps<typeof alertVariants> {
    readonly children: ReactNode;
    /** Extra classes merged onto the container (layout only). */
    readonly className?: string;
    /** Optional leading glyph (sized by the container). */
    readonly icon?: ReactNode;
    readonly testId?: string;
}

/**
 * A small inline callout banner — a tinted, bordered box for a status or error
 * message that sits within a panel (not a full-page empty state). Variants map to
 * the studio's semantic tones: `default` (neutral), `destructive` (errors),
 * `warning` (amber cautions). Replaces the copy-pasted
 * `border … bg-…/5 text-…` callout divs that had accreted across the panels.
 */
export const Alert = ({ children, className, icon, testId, variant }: AlertProps): ReactElement => (
    <div className={cn(alertVariants({ variant }), className)} data-testid={testId} role="alert">
        {icon}
        <div className="min-w-0 flex-1">{children}</div>
    </div>
);

export { alertVariants };
