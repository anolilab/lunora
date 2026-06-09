import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/utils";

interface EmptyStateProps {
    /** Optional call-to-action(s) rendered under the description. */
    readonly action?: ReactNode;
    readonly className?: string;
    /** One-line muted explanation under the title. */
    readonly description?: ReactNode;
    /** A small outline glyph shown in a rounded container above the title. */
    readonly icon?: ReactNode;
    readonly testId?: string;
    readonly title: ReactNode;
}

/**
 * A centered, Studio-style empty state: a muted icon chip, a title, a one-line
 * description, and an optional action — the look Supabase Studio uses for
 * "Create a table" / "No users" / "Create a bucket". Shared so every panel's
 * zero-data branch reads the same.
 */
export const EmptyState = ({ action, className, description, icon, testId, title }: EmptyStateProps): ReactElement => (
    <div
        className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center", className)}
        data-testid={testId}
    >
        {icon !== undefined && (
            <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">{icon}</span>
        )}
        <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">{title}</p>
            {description !== undefined && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
        </div>
        {action !== undefined && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
);
