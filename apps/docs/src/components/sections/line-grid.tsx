import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { FC } from "react";

import { cn } from "@/lib/utils";

const LineGrid: FC<{
    className?: ClassValue;
    length?: number;
    mode?: "dark" | "light";
}> = ({ className, length = 4, mode = "light" }) => (
    <div
        className={clsx("absolute top-0 right-0 bottom-0 left-0 -mr-[1px] -ml-[1px] grid h-full grid-cols-1", {
            "grid-cols-2": length === 2,
            "grid-cols-3": length === 3,
            "sm:grid-cols-2 lg:grid-cols-4": length === 4,
        })}
    >
        {Array.from({ length }, (_, index) => (
            <div
                className={cn(
                    "relative h-full border-r",
                    {
                        "border-background/10": mode === "light",
                        "border-l": index === 0,
                        "border-white/10": mode === "dark",
                        "hidden lg:block": index % 2 !== 0,
                    },
                    className,
                )}
                key={index}
            />
        ))}
    </div>
);

export default LineGrid;
