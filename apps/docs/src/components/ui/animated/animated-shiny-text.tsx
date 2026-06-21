import type { CSSProperties, FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface AnimatedShinyTextProperties {
    children: ReactNode;
    className?: string;
    shimmerWidth?: number;
}

const AnimatedShinyText: FC<AnimatedShinyTextProperties> = ({ children, className, shimmerWidth = 100 }) => (
    <p
        className={cn(
            "mx-auto max-w-md text-neutral-600/70 dark:text-neutral-400/70",

            // Shine effect
            "animate-shiny-text [background-size:var(--shiny-width)_100%] bg-clip-text [background-position:0_0] bg-no-repeat",

            // Shine gradient
            "bg-linear-to-r from-transparent via-black/80 via-50% to-transparent dark:via-white/80",

            className,
        )}
        style={
            {
                "--shiny-width": `${shimmerWidth}px`,
            } as CSSProperties
        }
    >
        {children}
    </p>
);

export default AnimatedShinyText;
