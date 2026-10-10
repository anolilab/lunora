import { cn } from "@/lib/utils";

/**
 * Shared class strings for the dashboard section bodies. They live apart from the
 * section primitives in `section-ui.tsx` so that file exports only components,
 * which keeps Fast Refresh able to preserve component state.
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
 * One constant rather than the same class string repeated per `<TableHead>` — the
 * design system treats labels as a single role, so they should have a single
 * definition. Applies to column headers and any other structural label.
 */
export const COLUMN_LABEL = "font-mono text-[10px] tracking-[0.09em] uppercase";
