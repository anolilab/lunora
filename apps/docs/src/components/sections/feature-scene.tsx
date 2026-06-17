import type { FC } from "react";

import { cn } from "@/lib/utils";

import Reveal from "./reveal";

/**
 * A product screenshot on an aurora "pedestal" — bordered frame, dramatic
 * shadow, and a glow pooling beneath it (Linear-style). See DESIGN.md §3.
 */
const SceneFrame: FC<{ alt: string; src: string }> = ({ alt, src }) => (
    <div className="relative">
        <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-10 top-1/4 bottom-[-14%] -z-0 blur-3xl"
            style={{ background: "radial-gradient(ellipse at 50% 92%, hsl(256 72% 68% / 0.30), hsl(186 84% 56% / 0.10) 45%, transparent 72%)" }}
        />
        <div className="relative z-10 overflow-hidden rounded-xl border border-white/12 shadow-2xl shadow-black/60 ring-1 ring-white/[0.04]">
            <img alt={alt} className="block w-full" loading="lazy" src={src} />
        </div>
    </div>
);

/**
 * A big breathing "scene": eyebrow + display headline + copy (+ optional
 * bullets) beside a spotlit product frame, alternating sides via `reverse`.
 */
const FeatureScene: FC<{
    alt: string;
    bullets?: string[];
    copy: string;
    eyebrow: string;
    image: string;
    reverse?: boolean;
    title: string;
}> = ({ alt, bullets, copy, eyebrow, image, reverse, title }) => (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <Reveal className={cn("flex flex-col gap-5", reverse && "lg:order-2")}>
            <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-white/45 uppercase">
                <span className="bg-royal-amethyst size-1.5 rounded-full" />
                {eyebrow}
            </span>
            <h3 className="font-display text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">{title}</h3>
            <p className="max-w-md text-base text-white/55 md:text-lg">{copy}</p>
            {bullets ? (
                <ul className="mt-1 flex flex-col gap-2.5">
                    {bullets.map((bullet) => (
                        <li className="flex items-start gap-2.5 text-sm text-white/60" key={bullet}>
                            <span className="bg-sky-sapphire mt-1.5 size-1 shrink-0 rounded-full" />
                            {bullet}
                        </li>
                    ))}
                </ul>
            ) : null}
        </Reveal>
        <Reveal className={cn(reverse && "lg:order-1")} delay={0.1}>
            <SceneFrame alt={alt} src={image} />
        </Reveal>
    </div>
);

export default FeatureScene;
