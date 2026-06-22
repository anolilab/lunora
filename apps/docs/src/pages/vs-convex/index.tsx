"use client";

import { ArrowRight, Minus } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";

/**
 * Lunora vs Convex — an honest comparison page (brand voice: show the trade-offs,
 * including where Convex still wins). Shared dark frame.
 */

type Cell = ReactNode;

interface Row {
    convex: Cell;
    criterion: string;
    lunora: Cell;
}

const yes = <span className="text-emerald-300">Yes</span>;
const no = (
    <span className="inline-flex items-center gap-1 text-white/35">
        <Minus className="size-3.5" /> No
    </span>
);

const rows: Row[] = [
    { convex: yes, criterion: "Type-safe end-to-end", lunora: yes },
    { convex: yes, criterion: "Real-time subscriptions", lunora: yes },
    {
        convex: <span className="text-white/55">Managed only</span>,
        criterion: "Runs on your own account",
        lunora: <span className="text-emerald-300">Yes — Cloudflare</span>,
    },
    { convex: no, criterion: "Self-host", lunora: yes },
    { convex: yes, criterion: "Managed cloud", lunora: <span className="text-white/55">Lunora Cloud (coming)</span> },
    { convex: no, criterion: "Open source", lunora: <span className="text-emerald-300">Yes (FSL → Apache-2.0)</span> },
    {
        convex: <span className="text-emerald-300">Broad, built-in</span>,
        criterion: "Feature breadth",
        lunora: <span className="text-white/55">Growing (add-ons)</span>,
    },
    { convex: <span className="text-emerald-300">Production-ready</span>, criterion: "Maturity", lunora: <span className="text-amber-300">Alpha</span> },
    { convex: <span className="text-white/55">Paid</span>, criterion: "Cost at idle", lunora: <span className="text-emerald-300">≈$0 (CF free tier)</span> },
];

const Verdict: FC<{ body: string; eyebrow: string; title: string }> = ({ body, eyebrow, title }) => (
    <div className="flex flex-col gap-3 p-8">
        <span className="font-mono text-xs tracking-wider text-white/40 uppercase">{eyebrow}</span>
        <h3 className="text-xl font-semibold text-white">{title}</h3>
        <p className="text-sm leading-relaxed text-white/55">{body}</p>
    </div>
);

const ConvexCompare: FC = () => (
    <>
        {/* Hero */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-40 pb-16 text-center sm:pt-48">
                <Reveal className="flex flex-col items-center gap-6">
                    <span className="flex items-center gap-2 border border-white/12 px-3 py-1 font-mono text-xs text-white/60">
                        <span className="size-1.5 bg-sky-sapphire" />
                        Comparison
                    </span>
                    <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                        Lunora <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">vs</span>{" "}
                        Convex
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-white/55">
                        Convex set the bar for real-time backend DX. Lunora gives you that same developer experience, but it runs on your own Cloudflare
                        account, or on Lunora Cloud. Same code, no lock-in. Here&apos;s the honest comparison, including where Convex still wins.
                    </p>
                </Reveal>
            </div>
        </section>

        {/* Comparison table */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11] py-12" data-nav-theme="dark">
            <div className="mx-auto max-w-4xl px-5">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-white/10 text-left">
                            <th className="py-3 pr-4 font-medium text-white/45" />
                            <th className="py-3 pr-4 font-semibold text-white">Lunora</th>
                            <th className="py-3 font-semibold text-white/70">Convex</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr className="border-b border-white/[0.06]" key={row.criterion}>
                                <td className="py-3 pr-4 text-white/55">{row.criterion}</td>
                                <td className="py-3 pr-4">{row.lunora}</td>
                                <td className="py-3 text-white/70">{row.convex}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>

        {/* Honest verdicts */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-px border-white/[0.08] md:grid-cols-2 md:border-x">
                <div className="border-b border-white/[0.08] md:border-r md:border-b-0">
                    <Verdict
                        body="Convex is broader and more mature. It has more batteries built in, a longer track record, and it's production-ready today. If you want the most features with the least decisions and don't mind running on their cloud, Convex is the safer pick right now."
                        eyebrow="Where Convex wins"
                        title="Breadth and maturity"
                    />
                </div>
                <Verdict
                    body="Lunora gives you ownership and choice. The same code self-hosts on your own Cloudflare account (≈$0 at idle) or runs on Lunora Cloud — you're never locked into one. It's open source, edge-native, and you pay Cloudflare prices, not SaaS prices. The trade today: it's alpha, with fewer built-in features."
                    eyebrow="Where Lunora is different"
                    title="Ownership, no lock-in, edge cost"
                />
            </div>
        </section>

        {/* Pick guide + CTA */}
        <section className="relative overflow-hidden border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-64 opacity-50"
                style={{ background: "radial-gradient(60% 100% at 50% 120%, hsl(256 72% 68% / 0.22), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-20 text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Want Convex&apos;s DX on your own infrastructure?</h2>
                <p className="max-w-lg text-white/55">
                    Lunora is alpha and open source. Try it on a side project and tell us where it breaks. Prefer managed? Join the Lunora Cloud waitlist.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <Pill primary to="/docs/$">
                        Start building
                        <ArrowRight className="size-4" />
                    </Pill>
                    <Pill to="/cloud">Lunora Cloud waitlist</Pill>
                </div>
            </div>
        </section>
    </>
);

export default ConvexCompare;
