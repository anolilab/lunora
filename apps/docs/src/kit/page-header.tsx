import type { FC, ReactNode } from "react";

import { Shell } from "@/kit/layout";
import { cn } from "@/lib/utils";

/**
 * The full-bleed page header: a saturated colour field with a dark panel
 * centred in it, aligned left to the shell gutter.
 *
 * The panel sits *inside* the field, vertically centred, with colour reading
 * above, below and beside it. The field is a fixed height rather than a fluid
 * one, so the header occupies the same share of the first screen at every
 * width and the page below always starts at a predictable place.
 *
 * An earlier version pulled the panel up with a negative margin so it
 * overhung the field's bottom edge. That was a misreading: measured across
 * widths, the panel is simply centred, and the "overhang" was a taller panel
 * spilling out of a shorter field at one breakpoint. Centring removes the
 * pull, the spacer, and the class of bug where the two drift apart.
 *
 * The field is CSS gradients, not a canvas: it is a static backdrop on the one
 * view every visitor loads, so a renderer would be bytes spent on nothing.
 */

// Fixed field heights. The panel centres itself in whichever applies, so there
// is nothing else to keep in step when these change.
const FIELD = {
    full: "h-[30rem] sm:h-[38rem] lg:h-[45rem]",
    short: "h-[22rem] sm:h-[26rem] lg:h-[30rem]",
};

const PageHeader: FC<{
    /** Panel content — meta row, title, actions. */
    children: ReactNode;
    className?: string;
    /** Panel width. `wide` suits a title that sits beside its description. */
    panelWidth?: "default" | "wide";
    /** `full` for the landing hero, `short` for section landing pages. */
    size?: "full" | "short";
}> = ({ children, className, panelWidth = "default", size = "full" }) => (
    // The bar keeps light ink over this field. Dark ink would need a field
    // that is genuinely light, and the aurora accents sit mid-lightness — so
    // the top scrim below guarantees contrast instead, whatever the hue.
    <header className={cn("relative", className)} data-nav-theme="dark">
        <div className={cn("relative overflow-hidden bg-canvas-deep", FIELD[size])}>
            {/* One brand colour with depth, not three in equal measure.
                Violet carries the field (it is the primary glow in the brand);
                cyan and rose are secondary blooms at the edges that give it
                dimension without turning it into a rainbow. An even three-way
                split reads as a stock mesh gradient and belongs to no brand. */}
            <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                    background: [
                        "radial-gradient(46% 58% at 14% 26%, var(--site-accent) 0%, transparent 40%)",
                        "radial-gradient(50% 60% at 84% 70%, var(--site-accent-3) 0%, transparent 40%)",
                        "linear-gradient(125deg, var(--site-accent-2) 0%, var(--site-accent-2) 42%, color-mix(in oklch, var(--site-accent-2) 78%, var(--site-accent-3)) 100%)",
                    ].join(", "),
                }}
            />
            {/* Halftone matrix. Punching canvas-coloured dots through the field
                gives it the plotted, resolved-from-cells look that a smooth
                gradient cannot, and costs one repeating background. */}
            <div
                aria-hidden="true"
                className="absolute inset-0 opacity-70"
                style={{
                    backgroundImage: "radial-gradient(circle at center, var(--site-canvas) 1.15px, transparent 1.2px)",
                    backgroundSize: "9px 9px",
                }}
            />
            {/* Backing for the fixed navbar. The bar is transparent here, so
                without this its light ink would sit straight on full-chroma
                accent and fail contrast at the top of the page. */}
            <div
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-24"
                style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--site-canvas) 72%, transparent), transparent)" }}
            />
            {/* Settle the field into the page rather than cutting it off. */}
            <div
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-1/4"
                style={{ background: "linear-gradient(180deg, transparent, var(--site-canvas))" }}
            />

            {/* The panel, centred in the field and aligned to the shell gutter.
            No border: the field behind it is already a hard value change, so an
            outline on top only draws a second edge where there is one. */}
            <Shell className="absolute inset-0 flex items-center">
                <div className={cn("w-full bg-canvas p-[clamp(1.5rem,1rem+2vw,3rem)]", panelWidth === "wide" ? "max-w-[50rem]" : "max-w-[40rem]")}>
                    {children}
                </div>
            </Shell>
        </div>
    </header>
);

export { PageHeader };
