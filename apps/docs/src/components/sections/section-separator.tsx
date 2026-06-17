import { clsx } from "clsx";
import type { FC } from "react";

const SectionSeparator: FC<{ bgColor?: string; fillColor?: string; mode?: "light" | "dark"; position: "bottom" | "top" }> = ({
    bgColor = "bg-background",
    fillColor = "fill-background",
    mode = "light",
    position,
}) => (
    <div
        className={clsx("absolute inset-x-0 z-10 mt-[calc(-3/16*1rem)] flex items-end", {
            "-bottom-11 rotate-180": position === "bottom",
            "-top-11": position === "top",
        })}
        data-nav-theme={mode}
    >
        <div className={`mr-[calc(-1*(--spacing(8)-(--spacing(1.5))))] h-11 flex-auto ${bgColor}`} />
        <div className="mx-auto flex w-full justify-between px-7 sm:max-w-160 md:max-w-3xl lg:max-w-5xl xl:max-w-7xl">
            <svg aria-hidden="true" className={`mb-[calc(-1/16*1rem)] w-14 flex-none overflow-visible ${fillColor}`} viewBox="0 0 56 48">
                <path d="M 2.686 3 H -4 V 48 H 56 V 47 H 53.314 A 8 8 0 0 1 47.657 44.657 L 8.343 5.343 A 8 8 0 0 0 2.686 3 Z" />
            </svg>
            <svg aria-hidden="true" className={`${fillColor} mr-0.5 mb-[calc(-1/16*1rem)] w-14 flex-none overflow-visible`} viewBox="0 0 56 48">
                <path d="M 53.314 3 H 60 V 48 H 0 V 47 H 2.686 A 8 8 0 0 0 8.343 44.657 L 47.657 5.343 A 8 8 0 0 1 53.314 3 Z" />
            </svg>
        </div>
        <div className={`${bgColor} ml-[calc(-1*(--spacing(8)-(--spacing(1.5))))] h-11 flex-auto`} />
    </div>
);

export default SectionSeparator;
