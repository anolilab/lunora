import type { ClassValue } from "clsx";
import type { FC, PropsWithChildren } from "react";

import LineGrid from "@/components/sections/line-grid";
import { cn } from "@/lib/utils";

const Section: FC<
    PropsWithChildren<{
        classes?: {
            childrenWrapper?: ClassValue;
            lineGrid?: ClassValue;
            pattern?: ClassValue;
            root?: ClassValue;
        };
        gridLength?: number;
        mode?: "dark" | "light";
        patternColor?: "sky-sapphire" | "crimson-energy" | "ivory" | "royal-amethyst";
        patternPosition?: "top" | "bottom";
    }>
> = ({ children, classes, gridLength = 4, mode = "light", patternColor, patternPosition = "bottom" }) => (
    <section className={cn("relative container mx-auto px-5 py-[120px] md:px-0", mode, classes?.root)} data-nav-theme={mode}>
        {patternColor && (
            <svg
                aria-hidden="true"
                className={cn(
                    "absolute inset-y-0 -left-px z-20 h-full w-px",
                    {
                        "[mask-image:linear-gradient(transparent,white)]": patternPosition === "bottom",
                        "[mask-image:linear-gradient(white,transparent)]": patternPosition === "top",
                    },
                    classes?.pattern,
                )}
            >
                <rect fill={`url(#pattern-${patternColor})`} height="100%" width="100%" />
            </svg>
        )}
        {gridLength > 0 && <LineGrid className={classes?.lineGrid} length={gridLength} mode={mode} />}
        {patternColor && (
            <svg
                aria-hidden="true"
                className={cn(
                    "absolute inset-y-0 -right-px z-20 h-full w-px",
                    {
                        "[mask-image:linear-gradient(transparent,white)]": patternPosition === "bottom",
                        "[mask-image:linear-gradient(white,transparent)]": patternPosition === "top",
                    },
                    classes?.pattern,
                )}
            >
                <rect fill={`url(#pattern-${patternColor})`} height="100%" width="100%" />
            </svg>
        )}
        <div className={cn("relative z-10 grid grid-cols-1 items-start sm:grid-cols-2 lg:grid-cols-4", classes?.childrenWrapper)}>{children}</div>
    </section>
);

export default Section;
