"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Minus } from "lucide-react";
import type { FC } from "react";

import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";

/**
 * Shared, data-driven "Lunora vs X" comparison page. One honest table + two
 * verdicts (where they win / where Lunora differs) + a CTA, in the shared dark
 * frame. Facts live in ./data; keep them accurate and sourced.
 */

export type Tone = "neutral" | "no" | "warn" | "yes";

/** Comparison page slugs (routes under /vs). Literal so `/vs/${slug}` typechecks. */
export type CompareSlug = "appwrite" | "convex" | "firebase" | "supabase";

export interface Cell {
    label: string;
    tone?: Tone;
}

export interface CompareRow {
    criterion: string;
    lunora: Cell;
    them: Cell;
}

export interface Verdict {
    body: string;
    title: string;
}

export interface Comparison {
    description: string;
    intro: string;
    lunoraDiffers: Verdict;
    /** Display name, e.g. "Convex". */
    name: string;
    rows: CompareRow[];
    /** Route slug under /vs, e.g. "convex". */
    slug: CompareSlug;
    theyWin: Verdict;
}

const TONE_CLASS: Record<Tone, string> = {
    neutral: "text-white/55",
    no: "text-white/35",
    warn: "text-amber-300",
    yes: "text-emerald-300",
};

const CellView: FC<{ cell: Cell }> = ({ cell }) => {
    const tone = cell.tone ?? "neutral";

    return (
        <span className={`inline-flex items-center gap-1.5 ${TONE_CLASS[tone]}`}>
            {tone === "no" ? <Minus className="size-3.5 shrink-0" /> : null}
            {cell.label}
        </span>
    );
};

export const ComparePage: FC<{ data: Comparison; others: { name: string; slug: CompareSlug }[] }> = ({ data, others }) => (
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
                        {data.name}
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-white/55">{data.intro}</p>
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
                            <th className="py-3 font-semibold text-white/70">{data.name}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((row) => (
                            <tr className="border-b border-white/[0.06] align-top" key={row.criterion}>
                                <td className="py-3 pr-4 text-white/55">{row.criterion}</td>
                                <td className="py-3 pr-4">
                                    <CellView cell={row.lunora} />
                                </td>
                                <td className="py-3">
                                    <CellView cell={row.them} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>

        {/* Honest verdicts */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-px border-white/[0.08] md:grid-cols-2 md:border-x">
                <div className="flex flex-col gap-3 border-b border-white/[0.08] p-8 md:border-r md:border-b-0">
                    <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Where {data.name} wins</span>
                    <h3 className="text-xl font-semibold text-white">{data.theyWin.title}</h3>
                    <p className="text-sm leading-relaxed text-white/55">{data.theyWin.body}</p>
                </div>
                <div className="flex flex-col gap-3 p-8">
                    <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Where Lunora differs</span>
                    <h3 className="text-xl font-semibold text-white">{data.lunoraDiffers.title}</h3>
                    <p className="text-sm leading-relaxed text-white/55">{data.lunoraDiffers.body}</p>
                </div>
            </div>
        </section>

        {/* CTA + other comparisons */}
        <section className="relative overflow-hidden border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-64 opacity-50"
                style={{ background: "radial-gradient(60% 100% at 50% 120%, hsl(256 72% 68% / 0.22), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-20 text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Try Lunora on your own Cloudflare.</h2>
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
                {others.length > 0 ? (
                    <p className="mt-2 text-sm text-white/40">
                        Compare with{" "}
                        {others.map((other, index) => (
                            <span key={other.slug}>
                                {index > 0 ? " · " : ""}
                                <Link className="text-white/65 underline decoration-white/20 underline-offset-2 hover:text-white" to={`/vs/${other.slug}`}>
                                    {other.name}
                                </Link>
                            </span>
                        ))}
                    </p>
                ) : null}
            </div>
        </section>
    </>
);
