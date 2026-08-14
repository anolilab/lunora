import { Link } from "@tanstack/react-router";
import type { FC, ReactNode } from "react";
import { Fragment } from "react";

import { GradientBlinds } from "@/kit/gradient-blinds";
import { Kicker, Shell } from "@/kit/layout";
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
// The fixed navbar's height. Every header has to clear it, and it is declared
// once here because the two places that need it silently disagreed when the bar
// grew from h-16 to h-28 — the hero panel ended up 16px underneath it.
const NAV_CLEARANCE = "pt-[var(--site-nav-height)]";

const FIELD = {
    article: "min-h-[max(460px,clamp(360px,38vw,500px))]",
    full: "min-h-[34rem] sm:min-h-[42rem] lg:min-h-[49rem]",
    short: "min-h-[19rem] sm:min-h-[21rem] lg:min-h-[24rem]",
};

// `bottom` sits the panel on the field's lower edge so the two share a line and
// the band ends where the panel does. A section landing page wants that: the
// header is a title bar, not a stage, and centring a short panel in a short
// field leaves a sliver of colour under it that reads as a mistake.
const PLACE = {
    bottom: "items-end",
    center: "items-center",
};

/**
 * Vertical padding for the header's content.
 *
 * `bare` is symmetric, so the field reads as an even margin around the box
 * rather than a gap above it and nothing below; the navbar clearance sits on
 * the field itself in that case. `panel` keeps the clearance here, and its
 * bottom depends on where the panel is anchored.
 */
const contentPadding = (variant: "bare" | "panel", align: "bottom" | "center"): string => {
    if (variant === "bare") {
        return "py-5";
    }

    return align === "bottom" ? `${NAV_CLEARANCE} pb-0` : `${NAV_CLEARANCE} pb-12`;
};

const PageHeader: FC<{
    /** Where the panel sits in the field. */
    align?: "bottom" | "center";

    /**
     * What paints the field. `blinds` is the shader the landing hero uses and
     * is now the default, so every page header is the same surface; `gradient`
     * is the static CSS field, kept for anywhere the WebGL cost is not wanted.
     */
    backdrop?: "blinds" | "gradient";
    /** Panel content — meta row, title, actions. */
    children: ReactNode;
    className?: string;

    /**
     * How loud the field is. `brand` is the full-chroma aurora — the landing
     * page's one colour moment. `muted` desaturates it to a near-black texture,
     * which is what an article header wants: the same surface, without spending
     * the accent on every page.
     */
    fieldTone?: "brand" | "muted";
    /** Panel width. `wide` suits a title that sits beside its description. */
    panelWidth?: "default" | "wide";

    /** `full` for the landing hero, `article` for page headers, `short` for title bars. */
    size?: "article" | "full" | "short";

    /**
     * Which palette the header runs in. `light` puts the panel and its type on
     * white; the shader then paints with `multiply` instead of `lighten`,
     * because lightening anything against white returns white and the rays
     * disappear entirely.
     */
    tone?: "dark" | "light";

    /**
     * `panel` sets the content in a canvas-coloured card on the field — the
     * landing hero. `bare` sets it directly on the field, which is what every
     * other page uses: an article header is a title, not a stage.
     */
    variant?: "bare" | "panel";
}> = ({
    align = "center",
    backdrop = "blinds",
    children,
    className,
    fieldTone = "brand",
    panelWidth = "default",
    size = "full",
    tone = "dark",
    variant = "panel",
}) => (
    // The bar keeps light ink over this field. Dark ink would need a field
    // that is genuinely light, and the aurora accents sit mid-lightness — so
    // the top scrim below guarantees contrast instead, whatever the hue.
    //
    // `z-30` clears the landing page's vertical guide rails (`z-20`), which run
    // the full page height. The field is a single full-bleed image and two
    // hairlines ruled across it cut it into thirds; sitting above them leaves
    // the rails intact everywhere else. Harmless where there are no rails, and
    // below the fixed navbar's `z-100` either way.
    <header className={cn("relative z-30", className)} data-nav-theme={tone} data-site-theme={tone === "light" ? "light" : undefined}>
        <div className={cn("relative flex overflow-hidden bg-canvas-deep", FIELD[size], PLACE[align], variant === "bare" && NAV_CLEARANCE)}>
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
                // No `animate-field-in` here. This wrapper mounts before the
                // shader has a canvas, so animating it faded an empty box and
                // the field still arrived as a cut once the first frame landed.
                // `GradientBlinds` reveals its own canvas on that frame instead,
                // which is the only moment there is anything to fade.
                <div className={cn("absolute inset-0", fieldTone === "muted" && "opacity-[0.22] grayscale")}>
                    <GradientBlinds
                        angle={45}
                        blindCount={32}
                        blindMinWidth={26}
                        className={tone === "light" ? "opacity-30" : undefined}
                        cycleSeconds={54}
                        distortAmount={0}
                        gradientColors={["--site-accent-2", "--site-accent-3", "--site-accent"]}
                        mixBlendMode={tone === "light" ? "multiply" : "lighten"}
                        mouseDampening={0.6}
                        noise={tone === "light" ? 0.08 : 0.18}
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
                    className="animate-field-in absolute inset-0 motion-reduce:animate-none"
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
            <Shell className={cn("pointer-events-none relative z-10 w-full", contentPadding(variant, align))}>
                <div
                    className={cn(
                        "pointer-events-auto w-full",
                        variant === "panel" && "bg-canvas p-[clamp(1.5rem,1rem+2vw,3rem)]",
                        variant === "panel" && (panelWidth === "wide" ? "max-w-[50rem]" : "max-w-[40rem]"),
                    )}
                >
                    {children}
                </div>
            </Shell>
        </div>
    </header>
);

/**
 * The header every page except the landing page uses.
 *
 * Opaque boxes sitting on the shared field, not type laid straight onto it: a
 * small one for the trail, a small one for the page kind, and a large one
 * carrying the title with the description and any action pinned to its floor.
 * The field reads between and around them.
 *
 * Boxing the copy is what makes the field usable at full chroma. Type set
 * directly on it measured 1.25:1 against the field's lightest stop, because the
 * rays move with the cursor and a bright band can pass behind any given word —
 * so the alternative was dimming the field to the point of being pointless.
 */
const MetaBox: FC<{ children: ReactNode }> = ({ children }) => <span className="flex items-center gap-2 bg-canvas px-3.5 py-2">{children}</span>;

const ArticleHeader: FC<{
    /** Bottom-right of the main box — a copy button, a link out. */
    actions?: ReactNode;
    /** Trail of links ending in the current page. The last entry is not a link. */
    breadcrumb?: { label: string; to?: string }[];
    className?: string;
    /** One line at the foot of the main box. */
    lead?: ReactNode;
    /** The kind of page this is — "Package reference", "Documentation". */
    meta?: ReactNode;
    title: ReactNode;
}> = ({ actions, breadcrumb, className, lead, meta, title }) => (
    <PageHeader align="center" className={className} size="article" variant="bare">
        {breadcrumb?.length || meta ? (
            <div className="mb-2 flex items-start justify-between gap-4">
                {breadcrumb?.length ? (
                    <MetaBox>
                        {breadcrumb.map((crumb, index) => (
                            <Fragment key={crumb.label}>
                                {index > 0 ? (
                                    <span aria-hidden="true" className="font-mono text-kicker text-ink-faint">
                                        /
                                    </span>
                                ) : null}
                                {crumb.to ? (
                                    <Link className="font-mono text-kicker uppercase text-ink-muted transition-colors hover:text-ink" to={crumb.to}>
                                        {crumb.label}
                                    </Link>
                                ) : (
                                    <Kicker tone="muted">{crumb.label}</Kicker>
                                )}
                            </Fragment>
                        ))}
                    </MetaBox>
                ) : (
                    <span />
                )}
                {meta ? (
                    <MetaBox>
                        <Kicker>{meta}</Kicker>
                    </MetaBox>
                ) : null}
            </div>
        ) : null}

        {/* The main box. `min-h` and `justify-between` are what hold the lead on
            the floor rather than letting it ride up under a one-line title. */}
        <div className="flex min-h-[18rem] flex-col justify-between gap-10 bg-canvas p-[clamp(1.5rem,1rem+2vw,3.5rem)]">
            <h1 className="max-w-[11em] text-[clamp(48px,6.8vw,88px)] leading-[0.94] font-bold tracking-[-0.045em] text-balance text-ink">{title}</h1>

            {lead || actions ? (
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    {lead ? <p className="max-w-2xl text-body text-ink-muted">{lead}</p> : null}
                    {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
                </div>
            ) : null}
        </div>
    </PageHeader>
);

export { ArticleHeader, PageHeader };
