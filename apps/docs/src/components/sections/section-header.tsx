import type { FC } from "react";

import { cn } from "@/lib/utils";

import Reveal from "./reveal";

/**
 * Standard section heading: mono eyebrow (aurora dot + uppercase label) → a
 * display-font headline → a muted subhead. See DESIGN.md §4. `align` centers or
 * left-aligns the block.
 */
const SectionHeader: FC<{ align?: "center" | "left"; className?: string; eyebrow?: string; subhead?: string; title: string }> = ({
    align = "left",
    className,
    eyebrow,
    subhead,
    title,
}) => (
    <Reveal className={cn("flex max-w-2xl flex-col gap-4", align === "center" && "mx-auto items-center text-center", className)}>
        {eyebrow ? (
            <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-white/45 uppercase">
                <span className="size-1.5 rounded-full bg-royal-amethyst" />
                {eyebrow}
            </span>
        ) : null}
        <h2 className="font-display text-3xl leading-[1.05] font-semibold tracking-tight text-balance text-white sm:text-4xl md:text-[2.75rem]">{title}</h2>
        {subhead ? <p className="text-base text-white/55 md:text-lg">{subhead}</p> : null}
    </Reveal>
);

export default SectionHeader;
