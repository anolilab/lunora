import type { FC } from "react";

import { cn } from "@/lib/utils";

/**
 * Seam between sections — a hairline rule with a soft aurora glow centered on
 * it. Replaces the old curvy SectionSeparator (DESIGN.md §3). Render at the top
 * of a section (or between two).
 */
const SectionDivider: FC<{ className?: string }> = ({ className }) => (
    <div aria-hidden="true" className={cn("relative h-px w-full", className)}>
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/12 to-transparent" />
        <div className="absolute left-1/2 top-1/2 h-24 w-1/2 -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,hsl(256_72%_68%/0.18),transparent)] blur-xl" />
    </div>
);

export default SectionDivider;
