import type { FC, ReactNode } from "react";

import { Shell } from "@/kit/layout";
import { cn } from "@/lib/utils";

/**
 * The full-bleed page header: a saturated colour field with a dark panel set
 * into its lower-left, overhanging the field's bottom edge.
 *
 * The overhang is the composition — a panel breaking the band's edge is what
 * stops this reading as a banner with a box on it.
 *
 * It is built by pulling the panel up into the field with a negative margin
 * while it stays in normal flow, rather than positioning it absolutely over
 * the field. In flow, the panel's own height decides how far it overhangs and
 * everything below is pushed down correctly for free; absolute positioning
 * would need a spacer kept manually in sync with a height that changes with
 * the content and the breakpoint.
 *
 * The field is CSS gradients, not a canvas: it is a static backdrop on the one
 * view every visitor loads, so a renderer would be bytes spent on nothing.
 */

const SIZE = {
    // Field height, then how far the panel is pulled up into it. The pull is
    // half the field so the panel's top edge lands on the field's midline.
    full: { field: "h-[32rem] sm:h-[38rem] lg:h-[45rem]", pull: "-mt-[16rem] sm:-mt-[19rem] lg:-mt-[22.5rem]" },
    short: { field: "h-[20rem] sm:h-[24rem] lg:h-[28rem]", pull: "-mt-[11rem] sm:-mt-[13rem] lg:-mt-[15rem]" },
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
        <div className={cn("relative overflow-hidden bg-canvas-deep", SIZE[size].field)}>
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
                className="absolute inset-x-0 top-0 h-32"
                style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--site-canvas) 72%, transparent), transparent)" }}
            />
            {/* Settle the field into the page rather than cutting it off. */}
            <div
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-1/3"
                style={{ background: "linear-gradient(180deg, transparent, var(--site-canvas))" }}
            />
        </div>

        <Shell className={cn("relative", SIZE[size].pull)}>
            <div
                className={cn(
                    "w-full border border-hairline bg-canvas p-[clamp(1.5rem,1rem+2vw,3rem)]",
                    panelWidth === "wide" ? "max-w-[46rem]" : "max-w-[34rem]",
                )}
            >
                {children}
            </div>
        </Shell>
    </header>
);

export { PageHeader };
