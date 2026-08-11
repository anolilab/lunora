import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import type { FC } from "react";

import { Kicker, Shell } from "@/kit/layout";

/**
 * The primitives Lunora is built on, directly under the hero.
 *
 * This is a "built on" strip, not a customer logo wall: Cloudflare's individual
 * primitives have no public marks, so they are set as type rather than faked as
 * logos. One real Cloudflare mark anchors the row.
 */

const PRIMITIVES = ["Workers", "Durable Objects", "D1", "R2", "Queues", "Workflows", "Vectorize", "Hyperdrive", "Workers AI"];

const PlatformStrip: FC = () => (
    <div className="border-y border-hairline bg-canvas-deep" data-nav-theme="dark">
        <Shell className="flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
            <span className="flex shrink-0 items-center gap-2.5 text-ink-muted">
                <SiCloudflare aria-hidden="true" className="size-5" color="default" />
                <Kicker tone="muted">Built on the Cloudflare Developer Platform</Kicker>
            </span>
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {PRIMITIVES.map((name) => (
                    <li className="font-mono text-blurb text-ink-faint transition-colors hover:text-ink" key={name}>
                        {name}
                    </li>
                ))}
            </ul>
        </Shell>
    </div>
);

export default PlatformStrip;
