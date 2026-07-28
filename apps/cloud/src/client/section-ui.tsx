import { SquareLockPasswordIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Shared presentation primitives for the dashboard section bodies, so every tab
 * renders lists, form fields, status, and errors the same way. Behaviour lives
 * in the sections themselves; this file is purely how they look — one source of
 * truth for the row rhythm, the mono-uppercase field labels, the status tones,
 * and the plan-gate upsell.
 */

/**
 * Base data-row layout — a hairline-separated row. Exported so an interactive
 * whole-row button or link can reuse the exact metrics.
 */
export const rowClassName = "flex w-full items-center gap-3 border-b border-border px-1 py-3 text-sm last:border-b-0";

/** Interactive variant — a whole-row link/button that highlights on hover. */
export const interactiveRowClassName = cn(rowClassName, "cursor-pointer text-left text-foreground transition-colors hover:bg-accent");

/** The list wrapper for {@link Row}s — no bullets, no gaps (rows carry their own rule). */
/**
 * The label voice: Geist Mono, ALL CAPS, tight tracking, tertiary size.
 *
 * One constant rather than the same class string repeated per `<TableHead>` — the
 * design system treats labels as a single role, so they should have a single
 * definition. Applies to column headers and any other structural label.
 */
export const COLUMN_LABEL = "font-mono text-[10px] tracking-[0.09em] uppercase";

export const RowList = ({ children }: { children: ReactNode }): ReactElement => <ul className="m-0 grid list-none gap-0 p-0">{children}</ul>;

/** One non-interactive data row. */
export const Row = ({ children, className }: { children: ReactNode; className?: string }): ReactElement => (
    <li className={cn(rowClassName, className)}>{children}</li>
);

/** Pushes a trailing action cluster to the right edge of a {@link Row}. */
export const RowActions = ({ children }: { children: ReactNode }): ReactElement => <span className="ml-auto flex items-center gap-1">{children}</span>;

/** Stacked form field — a mono-uppercase label over its control (instrument look). */
export const Field = ({ children, htmlFor, label }: { children: ReactNode; htmlFor?: string; label: ReactNode }): ReactElement => (
    <div className="grid gap-1.5">
        <Label className="font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase" htmlFor={htmlFor}>
            {label}
        </Label>
        {children}
    </div>
);

/** A vertical stack for the fields of a create/edit form (medium field rhythm). */
export const FieldForm = ({
    action,
    children,
    className,
    onSubmit,
}: {
    /**
     * A React 19 form action. PREFER THIS over `onSubmit`: an action works without
     * JavaScript and needs no `preventDefault`, which is what
     * `react-doctor/no-prevent-default` asks for and what PR #224 converted every
     * studio form to. `FieldForm` originally accepted only `onSubmit`, and that gap
     * alone was enough to make a later redesign quietly convert two screens back to
     * `preventDefault` — so the passthrough exists to stop that recurring.
     */
    action?: ComponentProps<"form">["action"];
    children: ReactNode;
    className?: string;
    /** Escape hatch for forms that genuinely need the event; prefer `action`. */
    onSubmit?: ComponentProps<"form">["onSubmit"];
}): ReactElement => (
    <form action={action} className={cn("grid max-w-md gap-4", className)} onSubmit={onSubmit}>
        {children}
    </form>
);

/** Inline validation line for a form. Renders nothing when there is no error. */
export const FormError = ({ message }: { message: null | string }): ReactElement | null =>
    message ? (
        <p className="text-sm text-destructive" role="alert">
            {message}
        </p>
    ) : null;

type StatusTone = "danger" | "info" | "neutral" | "success" | "warning";

const TONE_CLASS: Record<StatusTone, string> = {
    danger: "border-destructive/30 text-destructive",
    info: "border-info/40 text-info",
    neutral: "",
    success: "border-success/30 text-success",
    warning: "border-warning/40 text-warning",
};

/**
 * A lifecycle-status chip that colours the *value* by tone (never the row). Use
 * for meaningful states (verified/failed/on) and let the `neutral` tone (a plain
 * secondary chip) carry categorical labels like a role or kind.
 */
export const StatusBadge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }): ReactElement =>
    tone === "neutral" ? (
        <Badge variant="secondary">{children}</Badge>
    ) : (
        <Badge className={cn("bg-transparent", TONE_CLASS[tone])} variant="outline">
            {children}
        </Badge>
    );

/**
 * The plan-gate upsell shown when a tab needs a feature the org's plan lacks.
 * One shape for every gated Observability tab (Issues / Incidents / Alerts).
 */
export const Upsell = ({ children, title }: { children: ReactNode; title: string }): ReactElement => (
    <Card>
        <CardContent>
            <Empty className="border-0 py-8">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={SquareLockPasswordIcon} strokeWidth={2} />
                    </EmptyMedia>
                    <EmptyTitle>{title}</EmptyTitle>
                    <EmptyDescription>{children}</EmptyDescription>
                </EmptyHeader>
            </Empty>
        </CardContent>
    </Card>
);
