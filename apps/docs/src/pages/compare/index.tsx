"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { FC } from "react";

import Reveal from "@/components/sections/reveal";

import { COMPARE_LIST } from "./data";

/**
 * Compare index — links to each "Lunora vs X" page. Shared dark frame.
 */

const CompareIndex: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        {/* vertical guide lines at the container edges, full page height */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-hairline lg:block"
        />
        <section className="relative border-t border-hairline bg-canvas" data-nav-theme="dark">
            <div className="relative z-10 mx-auto flex max-w-4xl flex-col gap-10 px-5 pt-40 pb-24 sm:pt-48">
                <Reveal className="flex flex-col items-center gap-5 text-center">
                    <span className="flex items-center gap-2 border border-hairline px-3 py-1 font-mono text-xs text-ink-muted">
                        <span className="size-1.5 bg-sky-sapphire" />
                        Comparisons
                    </span>
                    <h1 className="max-w-2xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-ink sm:text-5xl">
                        How Lunora{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">compares.</span>
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-ink-muted">
                        Lunora is a type-safe, real-time backend that runs on your own Cloudflare account at the edge. Honest comparisons with the alternatives,
                        including where each one still wins.
                    </p>
                </Reveal>

                <div className="grid grid-cols-1 gap-px border border-hairline sm:grid-cols-2">
                    {COMPARE_LIST.map((item) => (
                        <Link className="group flex flex-col gap-2 bg-canvas p-7 transition-colors hover:bg-wash" key={item.slug} to={`/vs/${item.slug}`}>
                            <span className="flex items-center gap-2 text-lg font-semibold text-ink">
                                Lunora vs {item.name}
                                <ArrowRight className="size-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
                            </span>
                            <span className="text-sm leading-relaxed text-ink-muted">{item.tagline}</span>
                        </Link>
                    ))}
                </div>
            </div>
        </section>
    </div>
);

export default CompareIndex;
