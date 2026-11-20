import { SquareLockPasswordIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ClientOnly } from "@tanstack/react-router";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { COLUMN_LABEL } from "@/lib/typography";
import { cn } from "@/lib/utils";

import { captureEvent } from "./analytics";
import { formatDateTime, formatRelativeTime } from "./format";
import { rowClassName, rowDividerClassName } from "./section-styles";
import { useScreen } from "./tabs";

/**
 * Shared presentation primitives for the dashboard section bodies, so every tab
 * renders lists, form fields, status, and errors the same way. Behaviour lives
 * in the sections themselves; this file is purely how they look — one source of
 * truth for the row rhythm, the caps-locked labels, the status tones (dot + pill),
 * the key/value blocks, and the plan-gate upsell.
 */

/** The bordered block that holds a list of rows. Shared by {@link RowList} and {@link KeyValueList}. */
const BLOCK = "overflow-hidden rounded-xl border border-border bg-background/40";

/** The list wrapper for {@link Row}s: a bordered block with hairline dividers between rows. */
export const RowList = ({ children }: { children: ReactNode }): ReactElement => (
    <ul className={cn("m-0 grid list-none gap-0 p-0", BLOCK, rowDividerClassName)}>{children}</ul>
);

/** One non-interactive data row. */
export const Row = ({ children, className }: { children: ReactNode; className?: string }): ReactElement => (
    <li className={cn(rowClassName, className)}>{children}</li>
);

/** Pushes a trailing action cluster to the right edge of a {@link Row}. */
export const RowActions = ({ children }: { children: ReactNode }): ReactElement => <span className="ml-auto flex items-center gap-1">{children}</span>;

/** Stacked form field — a caps-locked label over its control. */
export const Field = ({ children, htmlFor, label }: { children: ReactNode; htmlFor?: string; label: ReactNode }): ReactElement => (
    <div className="grid gap-1.5">
        <Label className={cn(COLUMN_LABEL, "text-muted-foreground")} htmlFor={htmlFor}>
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
export const FormError = ({ message }: { message: null | string }): ReactElement | null => {
    const screen = useScreen();

    // Every form in the studio reports its failure through this one line, so
    // this counts the screens where operators get stuck — the shortest route to
    // "which form needs better validation, better copy, or fewer fields".
    //
    // The message itself is NOT sent: it is the one string here that is not
    // static copy. "domain example.com is already claimed" names a tenant's
    // hostname, and a server error can quote anything at all. The screen is the
    // part that is actionable anyway.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- the handler the rule wants this moved to is every form in the studio. The point of putting it here is that a screen added later is counted without anyone remembering to.
        if (message === null || message === "") {
            return;
        }

        captureEvent("studio_form_error", { screen });
    }, [message, screen]);

    return message ? (
        <p className="text-sm text-destructive" role="alert">
            {message}
        </p>
    ) : null;
};

type StatusTone = "danger" | "info" | "neutral" | "success" | "warning";

const TONE_PILL: Record<StatusTone, string> = {
    danger: "border-destructive/20 bg-destructive/10 text-destructive",
    info: "border-info/20 bg-info/10 text-info",
    neutral: "",
    success: "border-success/20 bg-success/10 text-success",
    warning: "border-warning/20 bg-warning/10 text-warning",
};

const TONE_DOT: Record<StatusTone, string> = {
    danger: "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklab,var(--destructive)_22%,transparent)]",
    info: "bg-info shadow-[0_0_0_3px_color-mix(in_oklab,var(--info)_22%,transparent)]",
    neutral: "bg-muted-foreground/60",
    success: "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_22%,transparent)]",
    warning: "bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]",
};

/** A small coloured status dot with a soft halo. Decorative: pair it with a text label. */
export const StatusDot = ({ className, tone = "neutral" }: { className?: string; tone?: StatusTone }): ReactElement => (
    <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[tone], className)} />
);

/**
 * A lifecycle-status pill that colours the *value* by tone (never the row), led by a
 * {@link StatusDot}. Use for meaningful states (verified/failed/on) and let the
 * `neutral` tone (a plain secondary chip) carry categorical labels like a role or kind.
 */
export const StatusBadge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }): ReactElement =>
    tone === "neutral" ? (
        <Badge variant="secondary">{children}</Badge>
    ) : (
        <Badge className={cn("gap-1.5", TONE_PILL[tone])} variant="outline">
            <StatusDot className="size-1.5 shadow-none" tone={tone} />
            {children}
        </Badge>
    );

/** A small count chip, shown beside a section label. */
const CountChip = ({ children }: { children: ReactNode }): ReactElement => (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
        {children}
    </span>
);

/** A caps-locked section heading, with an optional count chip and a right-aligned slot. */
export const SectionLabel = ({ action, children, count }: { action?: ReactNode; children: ReactNode; count?: number }): ReactElement => (
    <div className="flex items-center gap-2">
        <h3 className={cn("m-0 text-muted-foreground", COLUMN_LABEL)}>{children}</h3>
        {count === undefined ? null : <CountChip>{count}</CountChip>}
        {action ? <div className="ml-auto flex items-center gap-2">{action}</div> : null}
    </div>
);

/** A bordered block of label/value rows, with hairline dividers between them. */
export const KeyValueList = ({ children }: { children: ReactNode }): ReactElement => <dl className={cn("m-0 grid", BLOCK)}>{children}</dl>;

/** One row of a {@link KeyValueList}: a muted monospace label beside its value. */
export const KeyValueRow = ({ children, label }: { children: ReactNode; label: ReactNode }): ReactElement => (
    <div className="grid grid-cols-[minmax(11.5rem,38%)_1fr] border-b border-border/70 last:border-b-0">
        <dt className="border-e whitespace-nowrap border-border/70 bg-muted/25 px-4 py-2.5 font-mono text-[13px] text-muted-foreground">{label}</dt>
        <dd className="m-0 min-w-0 px-4 py-2.5 font-mono text-[13px] break-words text-foreground">{children}</dd>
    </div>
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

/**
 * The empty state of a tab listing hosts an organization brings (its boxes, its
 * Cloudflare accounts): what the host is for, and the action that adds one — or,
 * for a member who may not, who can.
 */
export const HostEmpty = ({
    action,
    children,
    fallback,
    icon,
    title,
}: {
    action: ReactNode;
    children: ReactNode;
    fallback: string;
    icon: IconSvgElement;
    title: string;
}): ReactElement => (
    <Empty className="border-0 py-10">
        <EmptyHeader>
            <EmptyMedia variant="icon">
                <HugeiconsIcon icon={icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
        <div className="flex justify-center">{action ?? <p className="m-0 text-sm text-muted-foreground">{fallback}</p>}</div>
    </Empty>
);

/**
 * A timestamp that is absolute on the server and relative in the browser.
 *
 * `ClientOnly` renders the fallback during SSR and on the first client pass, so
 * both sides agree on markup; the relative label ({@link formatRelativeTime})
 * appears once hydration is done. The fallback is the real timestamp rather than
 * a blank, so a reader with JavaScript still off sees when it happened.
 */
export const RelativeTime = ({ at }: { at: number }): ReactElement => <ClientOnly fallback={<>{formatDateTime(at)}</>}>{formatRelativeTime(at)}</ClientOnly>;

/**
 * Copy a literal (a command, a token) to the clipboard. The label flips to
 * "Copied" — announced through a live region — or to "Copy failed" where the
 * clipboard is unavailable (an insecure origin, a denied permission), so the
 * operator knows to select the text by hand.
 */
export const CopyButton = ({ label = "Copy", value }: { label?: string; value: string }): ReactElement => {
    const [state, setState] = useState<"failed" | "copied" | "idle">("idle");

    let text = label;

    if (state === "copied") {
        text = "Copied";
    } else if (state === "failed") {
        text = "Copy failed";
    }

    return (
        <Button
            onClick={() => {
                void (async () => {
                    try {
                        // Inside the try: `navigator.clipboard` is undefined on an insecure
                        // origin, and reading through it throws rather than rejecting.
                        await navigator.clipboard.writeText(value);
                        setState("copied");
                    } catch {
                        setState("failed");
                    }
                })();
            }}
            size="sm"
            type="button"
            variant="outline"
        >
            <span aria-live="polite">{text}</span>
        </Button>
    );
};
