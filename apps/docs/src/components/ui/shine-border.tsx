"use client";

import { cn } from "@/lib/utils";

type TColorProperty = string | string[];

interface ShineBorderProperties {
    borderRadius?: number;
    borderWidth?: number;
    children: React.ReactNode;
    className?: string;
    color?: TColorProperty;
    duration?: number;
}

/**
 * @name Shine Border
 * @description It is an animated background border effect component with easy to use and configurable props.
 * @param borderRadius defines the radius of the border.
 * @param borderWidth defines the width of the border.
 * @param duration defines the animation duration to be applied on the shining border
 * @param color a string or string array to define border color.
 * @param className defines the class name to be applied to the component
 * @param children contains react node elements.
 */
const ShineBorder = ({ borderRadius = 8, borderWidth = 1, children, className, color = "#000000", duration = 14 }: ShineBorderProperties) => (
    <div
        className={cn(
            "relative min-h-[60px] w-fit min-w-[300px] place-items-center rounded-(--border-radius) bg-white p-3 text-black dark:bg-black dark:text-white",
            className,
        )}
        style={
            {
                "--border-radius": `${borderRadius}px`,
            } as React.CSSProperties
        }
    >
        <div
            className={`before:bg-shine-size motion-safe:before:animate-border-shine pointer-events-none before:absolute before:inset-0 before:size-full before:rounded-(--border-radius) before:[background-image:var(--background-radial-gradient)] before:[background-size:300%_300%] before:[mask-composite:exclude]! before:p-(--border-width) before:will-change-[background-position] before:content-[""] before:[-webkit-mask-composite:xor]! before:[mask:var(--mask-linear-gradient)]`}
            style={
                {
                    "--background-radial-gradient": `radial-gradient(transparent,transparent, ${Array.isArray(color) ? color.join(",") : color},transparent,transparent)`,
                    "--border-radius": `${borderRadius}px`,
                    "--border-width": `${borderWidth}px`,
                    "--duration": `${duration}s`,
                    "--mask-linear-gradient": `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                } as React.CSSProperties
            }
        />
        {children}
    </div>
);

export default ShineBorder;
