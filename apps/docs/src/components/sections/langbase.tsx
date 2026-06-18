"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { FC, ReactNode } from "react";

import Reveal from "@/components/sections/reveal";
import { cn } from "@/lib/utils";

/**
 * Shared landing primitives: the centered `SectionHead` (eyebrow + title +
 * subtitle), pill buttons, and the closing CTA.
 */

const SectionHead: FC<{ eyebrow: string; subtitle: string; title: string }> = ({ eyebrow, subtitle, title }) => (
    <Reveal className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
        <span className="font-mono text-xs tracking-[0.18em] text-white/40 uppercase">{eyebrow}</span>
        <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">{title}</h2>
        <p className="text-base leading-relaxed text-white/55">{subtitle}</p>
    </Reveal>
);

const Pill: FC<{ children: ReactNode; href?: string; primary?: boolean; to?: string }> = ({ children, href, primary, to }) => {
    const className = cn(
        "inline-flex h-10 items-center gap-2 px-5 text-sm font-medium transition-colors",
        primary ? "bg-white text-black hover:bg-white/90" : "border border-white/15 text-white/85 hover:border-white/30 hover:bg-white/[0.06]",
    );

    if (href) {
        return (
            <a className={className} href={href} rel="noreferrer" target="_blank">
                {children}
            </a>
        );
    }

    return (
        <Link className={className} to={to ?? "/docs/$"}>
            {children}
        </Link>
    );
};

const ClosingCta: FC = () => (
    <section className="relative overflow-hidden border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-64 opacity-50"
            style={{ background: "radial-gradient(60% 100% at 50% 120%, hsl(256 72% 68% / 0.22), transparent 70%)" }}
        />
        <Reveal className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-28 text-center">
            <h2 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">Ready to ship realtime apps?</h2>
            <p className="max-w-lg text-base text-white/55">Open source, deployed to your own Cloudflare account, with no infrastructure to manage.</p>
            <Pill primary>
                Start building
                <ArrowRight className="size-4" />
            </Pill>
        </Reveal>
    </section>
);

export { ClosingCta, Pill, SectionHead };
