import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import type { CSSProperties, FC } from "react";

import { Kicker, Shell } from "@/kit/layout";

/**
 * The primitives Lunora is built on, directly under the hero.
 *
 * This is a "built on" strip, not a customer logo wall: Cloudflare's individual
 * primitives have no public marks, so they are set as type rather than faked as
 * logos. One real Cloudflare mark anchors the row.
 *
 * The strip is tinted to sit on the header's colour field rather than reading
 * as the first dark band of the page, so the field resolves into the page
 * instead of stopping at a hard edge. It carries `on-accent` ink for the same
 * reason the panel above it does not: this band is light, so its text is dark.
 *
 * `z-30` lifts it over the landing page's vertical guide rails (`z-20`), which
 * otherwise rule two hairlines straight down the band.
 *
 * The names scroll rather than wrap. A wrapped list is as tall as it needs to
 * be, so on a phone this band grew into three stacked rows of type before the
 * page had said anything; scrolling fixes its height at one row and lets the
 * viewport decide how many names are visible.
 */

const PRIMITIVES = ["Workers", "Durable Objects", "D1", "R2", "Queues", "Workflows", "Vectorize", "Hyperdrive", "Workers AI"];

// The track is the list twice over, and the animation shifts it by exactly half
// its width — so the moment the first copy leaves, the second is in the identical
// position and the loop is invisible. That only holds if both copies measure the
// same, which is why the spacing is trailing padding on each item rather than a
// flex `gap`: a gap is dropped after the last item, making the copies unequal
// and putting a visible stutter in every cycle.
const TRACK = [
    ...PRIMITIVES.map((name) => {
        return { echo: false, key: name, name };
    }),
    ...PRIMITIVES.map((name) => {
        return { echo: true, key: `${name}-echo`, name };
    }),
];

// Fade both ends so names enter and leave rather than being sliced by the edge.
const EDGE_FADE = "linear-gradient(90deg, transparent 0, #000 6%, #000 94%, transparent 100%)";

const PlatformStrip: FC = () => (
    // A quiet band, not a second gradient. The navbar carries the tinted hue
    // walk now, and the two sit ~60px apart at the top of the page — one
    // surface wearing that treatment reads as a signature, two stacked read as
    // a mistake. The strip keeps its job (the primitives, scrolling) and gives
    // up the colour.
    <div className="relative z-30 border-y border-hairline bg-canvas-deep" data-nav-theme="dark">
        <Shell className="flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:gap-8">
            <span className="flex shrink-0 items-center gap-2.5 text-ink">
                <SiCloudflare aria-hidden="true" className="size-5" />
                <Kicker className="text-ink-faint">Built on the Cloudflare Developer Platform</Kicker>
            </span>

            {/* Under `prefers-reduced-motion` the track stops, which would strand
                the later names off-screen — so the viewport becomes scrollable
                in that case and they stay reachable. */}
            <div className="relative min-w-0 flex-1 overflow-hidden motion-reduce:overflow-x-auto" style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}>
                <ul className="flex w-max animate-scroll-left hover:[animation-play-state:paused] motion-reduce:animate-none">
                    {TRACK.map((item) => (
                        <li
                            // The second copy is decoration: announcing it would
                            // read the whole platform list twice.
                            aria-hidden={item.echo}
                            className="pe-10 font-mono text-blurb whitespace-nowrap text-ink-faint transition-colors hover:text-ink"
                            key={item.key}
                        >
                            {item.name}
                        </li>
                    ))}
                </ul>
            </div>
        </Shell>
    </div>
);

export default PlatformStrip;
