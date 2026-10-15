import { cn } from "@/lib/utils";

/**
 * The class-name half of the dashboard's section primitives.
 *
 * Split out of `section-ui.tsx` because that file exports components: a module
 * that mixes components with plain values cannot keep component state across a
 * Fast Refresh edit, so touching one class string full-reloads whichever section
 * you were working in (`react-doctor/only-export-components`). Constants here,
 * components there.
 */

/** Base data-row layout. Rows carry no border of their own; their list draws the dividers. */
export const rowClassName = "flex w-full items-center gap-3 px-4 py-2.5 text-sm";

/**
 * Hairline dividers between a list's rows, applied to the list element. Putting the
 * divider on the list means a whole-row button inside its `&lt;li>` needs no border
 * workaround, and every row, interactive or not, gets the same rule.
 */
export const rowDividerClassName = "[&>li]:border-b [&>li]:border-border/70 [&>li:last-child]:border-b-0";

/**
 * Interactive variant: a whole-row link or button that highlights on hover. The focus
 * ring is inset so the list's `overflow-hidden` cannot clip it at the edges.
 */
export const interactiveRowClassName = cn(
    rowClassName,
    "cursor-pointer text-left text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
);
