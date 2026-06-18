"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Command } from "lucide-react";
import type { FC, ReactNode } from "react";

import GradientBars from "@/components/sections/gradient-bars";
import Reveal from "@/components/sections/reveal";
import { cn } from "@/lib/utils";

/**
 * Shared Langbase-style building blocks (aurora-tinted): the big `// label`
 * section marker, pill buttons, the blueprint product-section scaffold (a
 * bordered box with corner nodes, a transcript column, the marker, and a
 * description + CTA row), feature cards, a code panel, a quote band, and the
 * closing CTA. Composed by the home page.
 */

interface Feature {
    desc: string;
    title: string;
}

const KEYWORD = /^(?:import|from|const|export|async|await|function|return|new)$/;
const STRING = /^["'`]/;
const PUNCT = /^[{}()[\];,.=>:]+$/;
const SPLIT_WS = /(\s+)/;

const SectionMarker: FC<{ label: string }> = ({ label }) => (
    <h2 className="font-mono text-5xl font-medium tracking-tight text-white sm:text-6xl">
        <span className="text-white/25">//</span> {label}
    </h2>
);

const Pill: FC<{ children: ReactNode; href?: string; primary?: boolean; to?: string }> = ({ children, href, primary, to }) => {
    const className = cn(
        "inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-medium transition-colors",
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

const Node: FC<{ className: string }> = ({ className }) => <span aria-hidden="true" className={cn("absolute z-10 size-2 bg-white/70", className)} />;

const FeatureCard: FC<{ feature: Feature; seed: number }> = ({ feature, seed }) => (
    <div className="group flex flex-col gap-3 bg-white/[0.012] p-5 transition-colors hover:bg-white/[0.028]">
        <h3 className="font-mono text-sm font-normal text-white">
            <span className="text-white/30">// </span>
            {feature.title}
        </h3>
        <p className="text-xs leading-relaxed text-white/45">{feature.desc}</p>
        <GradientBars className="mt-2 h-24 w-full opacity-90 transition-opacity group-hover:opacity-100" rows={6} seed={seed} />
    </div>
);

const ProductSection: FC<{
    copy: string;
    cta?: string;
    features: Feature[];
    label: string;
}> = ({ copy, cta, features, label }) => (
    <section className="border-t border-white/[0.06] bg-black" data-nav-theme="dark">
        <div className="mx-auto max-w-6xl px-5 py-20">
            <Reveal className="relative border border-white/[0.08]">
                <Node className="top-0 left-0 -translate-x-1/2 -translate-y-1/2" />
                <Node className="top-0 right-0 translate-x-1/2 -translate-y-1/2" />
                <Node className="bottom-0 left-0 -translate-x-1/2 translate-y-1/2" />
                <Node className="bottom-0 right-0 translate-x-1/2 translate-y-1/2" />
                <Node className="top-0 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block" />
                <Node className="bottom-0 left-1/2 hidden -translate-x-1/2 translate-y-1/2 lg:block" />

                <div className="grid items-stretch lg:grid-cols-2">
                    {/* left: marker */}
                    <div className="flex items-center border-b border-white/[0.08] px-8 py-14 lg:border-r lg:border-b-0 lg:px-12">
                        <SectionMarker label={label} />
                    </div>
                    {/* right: copy + CTAs */}
                    <div className="flex flex-col justify-center gap-6 px-8 py-14 lg:px-12">
                        <p className="max-w-md text-lg leading-relaxed text-white/55">{copy}</p>
                        <div className="flex flex-wrap items-center gap-3">
                            <Pill primary>
                                <Command className="size-4" />
                                {cta ?? "Get started"}
                            </Pill>
                            <Pill>Docs</Pill>
                        </div>
                    </div>
                </div>
            </Reveal>

            <div className="mt-10 grid gap-px border border-white/[0.06] sm:grid-cols-3">
                {features.map((feature, index) => (
                    <Reveal delay={index * 0.06} key={feature.title}>
                        <FeatureCard feature={feature} seed={(index + 1) * 40} />
                    </Reveal>
                ))}
            </div>
        </div>
    </section>
);

const CodeLine: FC<{ text: string }> = ({ text }) => {
    if (!text.trim()) {
        return <span>&nbsp;</span>;
    }

    return (
        <>
            {text.split(SPLIT_WS).map((segment, index) => {
                if (!segment) {
                    return null;
                }

                let tone = "text-white/70";

                if (KEYWORD.test(segment)) {
                    tone = "text-royal-amethyst";
                } else if (STRING.test(segment)) {
                    tone = "text-crimson-energy/80";
                } else if (PUNCT.test(segment)) {
                    tone = "text-white/35";
                }

                return (
                    <span className={tone} key={index}>
                        {segment}
                    </span>
                );
            })}
        </>
    );
};

const CodePanel: FC<{ filename: string; lines: string[] }> = ({ filename, lines }) => (
    <Reveal className="mx-auto max-w-3xl">
        <div className="overflow-hidden border border-white/10 bg-[hsl(240_22%_4%)]">
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                <span className="size-2.5 bg-white/15" />
                <span className="size-2.5 bg-white/15" />
                <span className="size-2.5 bg-white/15" />
                <span className="ml-2 font-mono text-xs text-white/40">{filename}</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.85]">
                <code>
                    {lines.map((line, index) => (
                        <div className="whitespace-pre" key={index}>
                            <CodeLine text={line} />
                        </div>
                    ))}
                </code>
            </pre>
        </div>
    </Reveal>
);

const QuoteBand: FC<{ quote: string; source: string }> = ({ quote, source }) => (
    <section className="border-t border-white/[0.06] bg-black" data-nav-theme="dark">
        <Reveal className="mx-auto max-w-4xl px-5 py-24 text-center">
            <p className="text-2xl leading-snug font-medium tracking-tight text-balance text-white/90 sm:text-3xl">
                <span className="text-white/30">&ldquo;</span>
                {quote}
                <span className="text-white/30">&rdquo;</span>
            </p>
            <p className="mt-6 font-mono text-xs tracking-[0.16em] text-white/40 uppercase">{source}</p>
        </Reveal>
    </section>
);

const ClosingCta: FC = () => (
    <section className="relative overflow-hidden border-t border-white/[0.06] bg-black" data-nav-theme="dark">
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

export type { Feature };
export { ClosingCta, CodePanel, Pill, ProductSection, QuoteBand, SectionMarker };
