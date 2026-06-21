import { format } from "date-fns";
import type { FC, ReactNode } from "react";

/** Format an ISO/date string into a `MMM D, YYYY` (uppercased) label + ISO datetime. */
export const formatDate = (value?: string): { formatted: string; iso?: string } => {
    if (!value) {
        return { formatted: "" };
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return { formatted: "" };
    }

    return { formatted: format(date, "MMM d, yyyy").toUpperCase(), iso: date.toISOString() };
};

/** Up to two uppercase initials from a name, falling back to `L`. */
export const initials = (name?: string): string => {
    const computed = (name ?? "")
        .split(" ")
        .map((part) => part.charAt(0))
        .slice(0, 2)
        .join("")
        .toUpperCase();

    return computed === "" ? "L" : computed;
};

/** Mono, uppercase category/section label used across the blog. */
export const Eyebrow: FC<{ children: ReactNode }> = ({ children }) => (
    <span className="font-mono text-[11px] tracking-wider text-white/40 uppercase">{children}</span>
);
