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
    <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
        <div className="relative z-10 mx-auto flex max-w-4xl flex-col gap-10 px-5 pt-40 pb-24 sm:pt-48">
            <Reveal className="flex flex-col items-center gap-5 text-center">
                <span className="flex items-center gap-2 border border-white/12 px-3 py-1 font-mono text-xs text-white/60">
                    <span className="size-1.5 bg-sky-sapphire" />
                    Comparisons
                </span>
                <h1 className="max-w-2xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-white sm:text-5xl">
                    How Lunora{" "}
                    <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">compares.</span>
                </h1>
                <p className="max-w-xl text-lg leading-relaxed text-white/55">
                    Lunora is a type-safe, real-time backend that runs on your own Cloudflare account at the edge. Honest comparisons with the alternatives,
                    including where each one still wins.
                </p>
            </Reveal>

            <div className="grid grid-cols-1 gap-px border border-white/[0.08] sm:grid-cols-2">
                {COMPARE_LIST.map((item) => (
                    <Link
                        className="group flex flex-col gap-2 bg-[#0e0e11] p-7 transition-colors hover:bg-white/[0.03]"
                        key={item.slug}
                        to={`/vs/${item.slug}`}
                    >
                        <span className="flex items-center gap-2 text-lg font-semibold text-white">
                            Lunora vs {item.name}
                            <ArrowRight className="size-4 text-white/40 transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
                        </span>
                        <span className="text-sm leading-relaxed text-white/50">{item.tagline}</span>
                    </Link>
                ))}
            </div>
        </div>
    </section>
);

export default CompareIndex;
