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

/**
 * Base data-row layout — a hairline-separated row. Exported so an interactive
 * whole-row button or link can reuse the exact metrics.
 */
export const rowClassName = "flex w-full items-center gap-3 border-b border-border px-1 py-3 text-sm last:border-b-0";

/** Interactive variant — a whole-row link/button that highlights on hover. */
export const interactiveRowClassName = cn(rowClassName, "cursor-pointer text-left text-foreground transition-colors hover:bg-accent");

/**
 * The label voice: Geist Mono, ALL CAPS, tight tracking, tertiary size.
 *
 * One constant rather than the same class string repeated per `&lt;TableHead>` — the
 * design system treats labels as a single role, so they should have a single
 * definition. Applies to column headers and any other structural label.
 */
export const COLUMN_LABEL = "font-mono text-[10px] tracking-[0.09em] uppercase";
