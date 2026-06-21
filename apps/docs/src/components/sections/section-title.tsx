import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

const SectionTitle: FC<{
    classes?: {
        root?: ClassValue;
    };
    description?: ReactNode;
    mode?: "dark" | "light";
    position?: "left" | "center" | "right";
    prefix?: string;
    title: string;
}> = ({ classes, description, mode = "light", position = "left", prefix, title }) => (
    <div className={cn("flex flex-col gap-5", mode === "dark" && "dark", classes?.root)}>
        {prefix && (
            <span className={cn("flex items-center gap-2 font-mono text-sm tracking-wider uppercase", mode === "dark" ? "text-white/40" : "text-gray-400")}>
                <span className="inline-block h-px w-6 bg-gradient-to-r from-sky-sapphire/60 to-transparent" />
                {prefix}
            </span>
        )}
        <h2
            className={clsx("text-wrap-balance text-3xl font-bold tracking-tight lg:text-4xl", {
                "pl-20": position === "right",
                "pr-20": position === "left",
            })}
        >
            {title}
        </h2>
        {description && (
            <div
                className={clsx("text-wrap-balance mt-2 text-base/7", mode === "dark" ? "text-white/50" : "text-gray-500", {
                    "pl-20": position === "right",
                    "pr-20": position === "left",
                })}
            >
                {description}
            </div>
        )}
    </div>
);

export default SectionTitle;
