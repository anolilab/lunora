import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import type { FC } from "react";

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
 */

const PRIMITIVES = ["Workers", "Durable Objects", "D1", "R2", "Queues", "Workflows", "Vectorize", "Hyperdrive", "Workers AI"];

const PlatformStrip: FC = () => (
    <div
        className="border-b border-on-accent/15"
        data-nav-theme="light"
        style={{
            background: "linear-gradient(100deg, var(--site-accent-2), color-mix(in oklch, var(--site-accent-2) 72%, var(--site-accent-3)))",
        }}
    >
        <Shell className="flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
            <span className="flex shrink-0 items-center gap-2.5 text-on-accent">
                <SiCloudflare aria-hidden="true" className="size-5" />
                <Kicker className="text-on-accent/80">Built on the Cloudflare Developer Platform</Kicker>
            </span>
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {PRIMITIVES.map((name) => (
                    <li className="font-mono text-blurb text-on-accent/70 transition-colors hover:text-on-accent" key={name}>
                        {name}
                    </li>
                ))}
            </ul>
        </Shell>
    </div>
);

export default PlatformStrip;
