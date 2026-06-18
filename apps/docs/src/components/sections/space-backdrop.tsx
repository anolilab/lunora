import type { FC } from "react";

import { cn } from "@/lib/utils";

/**
 * Ambient dark-space photo backdrop (Unsplash) for a section — desaturated to
 * black-and-white and heavily scrimmed (a flat black veil plus a bottom-fading
 * gradient) so headlines, code, and cards stay legible while the image only
 * adds depth. Positioning is supplied by `className` (e.g. "absolute inset-0");
 * pass `fade` to dissolve the bottom, or `grayscale={false}` to keep colour.
 */

const MASK = "linear-gradient(to bottom, black 58%, transparent)";

const spaceUrl = (id: string): string => `https://images.unsplash.com/${id}?q=80&w=2200&auto=format&fit=crop`;

const SpaceBackdrop: FC<{ className?: string; fade?: boolean; grayscale?: boolean; id: string; opacity?: number }> = ({
    className,
    fade,
    grayscale = true,
    id,
    opacity = 0.34,
}) => (
    <div
        aria-hidden="true"
        className={cn("pointer-events-none overflow-hidden", className)}
        style={fade ? { maskImage: MASK, WebkitMaskImage: MASK } : undefined}
    >
        <img alt="" className={cn("size-full object-cover", grayscale && "grayscale")} loading="lazy" src={spaceUrl(id)} style={{ opacity }} />
        <div className="absolute inset-0 bg-black/40" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/15 to-black" />
    </div>
);

export default SpaceBackdrop;
