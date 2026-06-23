import type { FC, ReactNode } from "react";

import LunoraLogomark from "@/assets/lunora_logo.svg?react";
import LunoraWordmark from "@/assets/lunora_text.svg?react";
import HatchSpacer from "@/components/sections/hatch-spacer";
import { SectionHead } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import SupportSection from "@/pages/home/sections/support";

/**
 * Press & brand page — the public home for Lunora's logo, wordmark, color
 * palette, and boilerplate copy. Mirrors the landing frame (dark `#0e0e11`
 * container with `max-w-6xl` guide lines) so the trailing `SupportSection`
 * lines up with the same edges.
 */

interface Swatch {
    css: string;
    name: string;
    note: string;
    swatchClass: string;
}

// The aurora palette — values mirror marketing/design-tokens/tokens.css.
const swatches: Swatch[] = [
    { css: "#0E0E11", name: "Eclipse", note: "Page & body base", swatchClass: "bg-[#0e0e11] border border-white/15" },
    { css: "hsl(186 84% 56%)", name: "Aurora Cyan", note: "Info · active", swatchClass: "bg-aurora-cyan" },
    { css: "hsl(256 72% 68%)", name: "Aurora Violet", note: "Primary · brand", swatchClass: "bg-aurora-violet" },
    { css: "hsl(330 80% 64%)", name: "Aurora Rose", note: "Emphasis", swatchClass: "bg-aurora-rose" },
];

interface Download {
    href: string;
    label: string;
}

interface LogoBlock {
    dark?: boolean;
    downloads: Download[];
    logo: ReactNode;
    title: string;
}

const logoBlocks: LogoBlock[] = [
    {
        downloads: [
            { href: "/brand/lunora-logomark-light.svg", label: "SVG · light" },
            { href: "/brand/lunora-logomark-dark.svg", label: "SVG · dark" },
            { href: "/brand/lunora-logomark-violet.svg", label: "SVG · violet" },
        ],
        logo: <LunoraLogomark className="h-16 w-auto text-white" />,
        title: "Logomark",
    },
    {
        downloads: [
            { href: "/brand/lunora-wordmark-light.svg", label: "SVG · light" },
            { href: "/brand/lunora-wordmark-dark.svg", label: "SVG · dark" },
        ],
        logo: <LunoraWordmark className="h-9 w-auto text-white" />,
        title: "Wordmark",
    },
];

const dos = [
    "Keep clear space around the mark — at least the height of the moon's crescent.",
    "Use the violet or light mark on dark surfaces; the dark mark on light ones.",
    'Refer to the project as "Lunora" — capital L, one word.',
];

const donts = [
    "Don't recolor the mark outside the aurora palette or add effects/shadows.",
    "Don't stretch, rotate, or rebuild the logo, or set it on low-contrast backgrounds.",
    'Don\'t write "lunora", "LunoRa", or "Lunora.sh" in running text.',
];

const BOILERPLATE =
    "Lunora is a type-safe, real-time backend framework for Cloudflare Workers and Durable Objects with a Vite-first developer experience. Define your schema, queries, and mutations in TypeScript; Lunora keeps server and client types in lockstep, streams live updates over WebSockets, and runs your data at the edge — sharded or globally replicated.";

const Tile: FC<{ children: ReactNode; dark?: boolean }> = ({ children, dark }) => (
    <div className={`flex h-40 items-center justify-center ${dark ? "bg-[#0e0e11]" : "bg-white"}`}>{children}</div>
);

const Press: FC = () => (
    <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
        {/* vertical guide lines at the container edges — matches the landing page */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
        />

        <section className="relative" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 pt-32 pb-16 lg:px-0">
                <SectionHead
                    eyebrow="Press & Brand"
                    subtitle="Logos, colors, and copy for writing about Lunora. Please keep the marks intact and use the names as shown."
                    title="Brand assets"
                />
            </div>
        </section>

        <HatchSpacer />

        {/* logos */}
        <section className="border-t border-white/[0.08]" data-nav-theme="dark">
            <div className="mx-auto grid max-w-6xl grid-cols-1 gap-px bg-white/[0.08] md:grid-cols-2">
                {logoBlocks.map((block) => (
                    <Reveal className="bg-[#0e0e11] p-8" key={block.title}>
                        <h2 className="text-lg font-medium tracking-tight text-white">{block.title}</h2>
                        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden border border-white/[0.08]">
                            <Tile dark>{block.logo}</Tile>
                            <Tile>
                                {block.title === "Logomark" ? (
                                    <LunoraLogomark className="h-16 w-auto text-[#0e0e11]" />
                                ) : (
                                    <LunoraWordmark className="h-9 w-auto text-[#0e0e11]" />
                                )}
                            </Tile>
                        </div>
                        <div className="mt-5 flex flex-wrap gap-2">
                            {block.downloads.map((download) => (
                                <a
                                    className="border border-white/15 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-white/30 hover:text-white"
                                    download
                                    href={download.href}
                                    key={download.href}
                                >
                                    {download.label}
                                </a>
                            ))}
                        </div>
                    </Reveal>
                ))}
            </div>
        </section>

        <HatchSpacer />

        {/* colors */}
        <section className="border-t border-white/[0.08]" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-16 lg:px-0">
                <h2 className="text-lg font-medium tracking-tight text-white">Colors</h2>
                <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-white/50">
                    Eclipse anchors every surface; the aurora ramp (cyan → violet → rose) is an accent — light, not paint.
                </p>
                <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
                    {swatches.map((swatch) => (
                        <div key={swatch.name}>
                            <div className={`h-24 w-full ${swatch.swatchClass}`} />
                            <p className="mt-3 text-sm font-medium text-white">{swatch.name}</p>
                            <p className="font-mono text-xs text-white/50">{swatch.css}</p>
                            <p className="mt-0.5 text-xs text-white/40">{swatch.note}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>

        <HatchSpacer />

        {/* boilerplate */}
        <section className="border-t border-white/[0.08]" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-16 lg:px-0">
                <h2 className="text-lg font-medium tracking-tight text-white">Boilerplate</h2>
                <p className="mt-5 max-w-3xl text-base leading-relaxed text-white/70">{BOILERPLATE}</p>
            </div>
        </section>

        <HatchSpacer />

        {/* usage */}
        <section className="border-t border-white/[0.08]" data-nav-theme="dark">
            <div className="mx-auto grid max-w-6xl grid-cols-1 gap-px bg-white/[0.08] md:grid-cols-2">
                <div className="bg-[#0e0e11] p-8">
                    <h3 className="text-sm font-semibold tracking-[0.12em] text-aurora-cyan uppercase">Do</h3>
                    <ul className="mt-4 space-y-3">
                        {dos.map((item) => (
                            <li className="text-sm leading-relaxed text-white/60" key={item}>
                                {item}
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="bg-[#0e0e11] p-8">
                    <h3 className="text-sm font-semibold tracking-[0.12em] text-aurora-rose uppercase">Don&apos;t</h3>
                    <ul className="mt-4 space-y-3">
                        {donts.map((item) => (
                            <li className="text-sm leading-relaxed text-white/60" key={item}>
                                {item}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </section>

        <HatchSpacer />

        {/* contact */}
        <section className="border-t border-white/[0.08]" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-16 lg:px-0">
                <h2 className="text-lg font-medium tracking-tight text-white">Press inquiries</h2>
                <p className="mt-3 text-sm text-white/50">
                    Questions, interviews, or anything not covered here —{" "}
                    <a className="text-aurora-violet underline-offset-4 hover:underline" href="mailto:press@lunora.sh">
                        press@lunora.sh
                    </a>
                    .
                </p>
            </div>
        </section>

        <HatchSpacer />

        <SupportSection />
    </div>
);

export default Press;
