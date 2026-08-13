import type { FC, ReactNode } from "react";

import { GradientBlinds } from "@/kit/gradient-blinds";
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

// Field heights are a floor, not a fixture. They were fixed once, so the header
// took the same share of the first screen at every width — but the panel was
// absolutely positioned inside them, so a panel taller than its field silently
// overflowed: it slid under the fixed navbar at the top and was cut off by the
// field's own `overflow-hidden` at the bottom. It did exactly that the first
// time the hero panel grew, and it would have failed worst on a phone, where
// the field is shortest and the panel stacks tallest.
//
// A minimum plus a panel in normal flow keeps the intent — the header still
// fills that much of the screen — and lets it grow rather than clip.
const FIELD = {
    full: "min-h-[30rem] sm:min-h-[38rem] lg:min-h-[45rem]",
    short: "min-h-[15rem] sm:min-h-[17rem] lg:min-h-[19rem]",
};

// `bottom` sits the panel on the field's lower edge so the two share a line and
// the band ends where the panel does. A section landing page wants that: the
// header is a title bar, not a stage, and centring a short panel in a short
// field leaves a sliver of colour under it that reads as a mistake.
const PLACE = {
    bottom: "items-end",
    center: "items-center",
};

const PageHeader: FC<{
    /** Where the panel sits in the field. */
    align?: "bottom" | "center";

    /**
     * What paints the field. `gradient` is static CSS and costs nothing;
     * `blinds` is a WebGL shader and is reserved for the landing hero, where
     * one animated surface is the page's single moment of motion.
     */
    backdrop?: "blinds" | "gradient";
    /** Panel content — meta row, title, actions. */
    children: ReactNode;
    className?: string;
    /** Panel width. `wide` suits a title that sits beside its description. */
    panelWidth?: "default" | "wide";
    /** `full` for the landing hero, `short` for section landing pages. */
    size?: "full" | "short";
}> = ({ align = "center", backdrop = "gradient", children, className, panelWidth = "default", size = "full" }) => (
    // The bar keeps light ink over this field. Dark ink would need a field
    // that is genuinely light, and the aurora accents sit mid-lightness — so
    // the top scrim below guarantees contrast instead, whatever the hue.
    //
    // `z-30` clears the landing page's vertical guide rails (`z-20`), which run
    // the full page height. The field is a single full-bleed image and two
    // hairlines ruled across it cut it into thirds; sitting above them leaves
    // the rails intact everywhere else. Harmless where there are no rails, and
    // below the fixed navbar's `z-100` either way.
    <header className={cn("relative z-30", className)} data-nav-theme="dark">
        <div className={cn("relative flex overflow-hidden bg-canvas-deep", FIELD[size], PLACE[align])}>
            {/* One brand colour with depth, not three in equal measure.
                Violet carries the field (it is the primary glow in the brand);
                cyan and rose are secondary blooms at the edges that give it
                dimension without turning it into a rainbow. An even three-way
                split reads as a stock mesh gradient and belongs to no brand. */}
            {backdrop === "blinds" ? (
                // All three accents, but never all three at once: the field
                // shows two adjacent stops and walks the window along, so it
                // drifts violet → rose → cyan over a slow minute instead of
                // painting the stock three-way mesh that belongs to no brand.
                <div className="absolute inset-0">
                    <GradientBlinds
                        angle={45}
                        blindCount={32}
                        blindMinWidth={26}
                        cycleSeconds={54}
                        distortAmount={0}
                        gradientColors={["--site-accent-2", "--site-accent-3", "--site-accent"]}
                        mouseDampening={0.6}
                        noise={0.18}
                        spotlightRadius={0.62}
                    />
                    {/* Vignette. The shader's own falloff bottoms out well above
                        black, which leaves the rays running flat to all four
                        edges; pulling the corners down to canvas is what makes
                        them read as a lit core rather than a tiled pattern. */}
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{ background: "radial-gradient(96% 88% at 52% 42%, transparent 0%, transparent 46%, var(--site-canvas) 100%)" }}
                    />
                </div>
            ) : (
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
            )}
            {/* Every layer from here down is decoration stacked over the field,
                and every one of them is `pointer-events-none`. The `blinds`
                backdrop tracks the cursor, and a full-bleed overlay that eats
                `pointermove` leaves it frozen — which looks exactly like a
                shader that is not animating. */}

            {/* Halftone matrix, on the CSS field only. Punching canvas-coloured
                dots through a smooth gradient gives it the plotted,
                resolved-from-cells look it cannot get on its own, for the cost
                of one repeating background. The shader does not need it — its
                blinds already break the field into discrete edges, and the dots
                on top only sit as a screen door over them. */}
            {backdrop === "gradient" ? (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-70"
                    style={{
                        backgroundImage: "radial-gradient(circle at center, var(--site-canvas) 1.15px, transparent 1.2px)",
                        backgroundSize: "9px 9px",
                    }}
                />
            ) : null}
            {/* Backing for the fixed navbar. The bar is transparent here, so
                without this its light ink would sit straight on full-chroma
                accent and fail contrast at the top of the page. */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-24"
                style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--site-canvas) 72%, transparent), transparent)" }}
            />
            {/* Settle the field into the page rather than cutting it off. */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4"
                style={{ background: "linear-gradient(180deg, transparent, var(--site-canvas))" }}
            />

            {/* The panel, in normal flow so the field grows to hold it, and
            aligned to the shell gutter. No border: the field behind it is
            already a hard value change, so an outline on top only draws a
            second edge where there is one.

            `pt` clears the fixed navbar, which is why the panel cannot simply be
            centred in the raw field. `align="bottom"` keeps its lower edge flush
            with the field's, which is the whole point of that variant. */}
            <Shell className={cn("pointer-events-none relative z-10 w-full pt-24", align === "bottom" ? "pb-0" : "pb-12")}>
                <div
                    className={cn(
                        "pointer-events-auto w-full bg-canvas p-[clamp(1.5rem,1rem+2vw,3rem)]",
                        panelWidth === "wide" ? "max-w-[50rem]" : "max-w-[40rem]",
                    )}
                >
                    {children}
                </div>
            </Shell>
        </div>
    </header>
);

export { PageHeader };
