import type { FC } from "react";

import spaceBackdrop from "@/assets/images/space-backdrop.webp";
import { cn } from "@/lib/utils";

/**
 * Ambient dark-space photo backdrop for a section — desaturated to
 * black-and-white and heavily scrimmed (a flat black veil plus a bottom-fading
 * gradient) so headlines, code, and cards stay legible while the image only
 * adds depth. Positioning is supplied by `className` (e.g. "absolute inset-0");
 * pass `fade` to dissolve the bottom, or `grayscale={false}` to keep colour.
 *
 * The photo is bundled rather than hotlinked from the stock host it came from:
 * a remote `<img>` hands the visitor's IP to a third party on page load, which
 * needs a legal basis and a line in the privacy policy for a decoration.
 */

const MASK = "linear-gradient(to bottom, black 58%, transparent)";

const SpaceBackdrop: FC<{ className?: string; fade?: boolean; grayscale?: boolean; opacity?: number }> = ({
    className,
    fade,
    grayscale = true,
    opacity = 0.34,
}) => (
    <div
        aria-hidden="true"
        className={cn("pointer-events-none overflow-hidden", className)}
        style={fade ? { maskImage: MASK, WebkitMaskImage: MASK } : undefined}
    >
        <img alt="" className={cn("size-full object-cover", grayscale && "grayscale")} loading="lazy" src={spaceBackdrop} style={{ opacity }} />
        <div className="absolute inset-0 bg-black/40" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/15 to-black" />
    </div>
);

export default SpaceBackdrop;
