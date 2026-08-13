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
    <div
        className="relative z-30 animate-strip-hue border-b border-on-accent/15 motion-reduce:animate-none"
        data-nav-theme="light"
        // The stops are set here rather than left to the `@property` defaults so
        // a re-brand reaches them, and so the band still paints its theme colour
        // when the animation is off — under `prefers-reduced-motion`, or before
        // the stylesheet lands. These are the loop's first frame, so stopping is
        // a freeze rather than a jump to some other colour.
        style={
            {
                "--strip-a": "var(--site-accent-tint)",
                "--strip-b": "var(--site-accent-2-tint)",
                backgroundImage: "linear-gradient(100deg, var(--strip-a), var(--strip-b))",
            } as CSSProperties
        }
    >
        <Shell className="flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:gap-8">
            <span className="flex shrink-0 items-center gap-2.5 text-on-accent">
                <SiCloudflare aria-hidden="true" className="size-5" />
                <Kicker className="text-on-accent/80">Built on the Cloudflare Developer Platform</Kicker>
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
                            className="pe-10 font-mono text-blurb whitespace-nowrap text-on-accent/80 transition-colors hover:text-on-accent"
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
