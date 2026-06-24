"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Minus } from "lucide-react";
import type { FC } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import { createJsonLd, SITE_URL } from "@/lib/seo";

/**
 * Shared, data-driven "Lunora vs X" comparison page: breadcrumb, an honest table,
 * a prose summary, two verdicts (where they win / where Lunora differs), an FAQ,
 * and a CTA, in the shared dark frame. Emits BreadcrumbList + FAQPage JSON-LD.
 * Facts live in ./data; keep them accurate and sourced.
 */

type Tone = "neutral" | "no" | "warn" | "yes";

/** Comparison page slugs (routes under /vs). Literal so `/vs/${slug}` typechecks. */
type CompareSlug = "appwrite" | "convex" | "firebase" | "supabase";

interface Cell {
    label: string;
    tone?: Tone;
}

interface CompareRow {
    criterion: string;
    lunora: Cell;
    them: Cell;
}

interface Verdict {
    body: string;
    title: string;
}

interface Faq {
    a: string;
    q: string;
}

interface Comparison {
    description: string;
    /** FAQ — rendered as content and emitted as FAQPage structured data. */
    faqs: Faq[];
    intro: string;
    lunoraDiffers: Verdict;
    /** Display name, e.g. "Convex". */
    name: string;
    rows: CompareRow[];
    /** Route slug under /vs, e.g. "convex". */
    slug: CompareSlug;
    /** Longer prose for content depth — paragraphs. */
    summary: string[];
    theyWin: Verdict;
}

const TONE_CLASS: Record<Tone, string> = {
    neutral: "text-white/55",
    no: "text-white/35",
    warn: "text-amber-300",
    yes: "text-emerald-300",
};

// Escape `<` so a stray "</script>" in data can't break out of the JSON-LD block.
const safeJsonLd = (value: string): string => value.replaceAll("<", String.raw`\u003c`);

const CellView: FC<{ cell: Cell }> = ({ cell }) => {
    const tone = cell.tone ?? "neutral";

    return (
        <span className={`inline-flex items-center gap-1.5 ${TONE_CLASS[tone]}`}>
            {tone === "no" ? <Minus className="size-3.5 shrink-0" /> : null}
            {cell.label}
        </span>
    );
};

export const ComparePage: FC<{ data: Comparison; others: { name: string; slug: CompareSlug }[] }> = ({ data, others }) => {
    const breadcrumbLd = safeJsonLd(
        createJsonLd({
            "@type": "BreadcrumbList",
            itemListElement: [
                { "@type": "ListItem", item: SITE_URL, name: "Home", position: 1 },
                { "@type": "ListItem", item: `${SITE_URL}/compare`, name: "Compare", position: 2 },
                { "@type": "ListItem", item: `${SITE_URL}/vs/${data.slug}`, name: `Lunora vs ${data.name}`, position: 3 },
            ],
        }),
    );
    const faqLd = safeJsonLd(
        createJsonLd({
            "@type": "FAQPage",
            mainEntity: data.faqs.map((faq) => {
                return {
                    "@type": "Question",
                    acceptedAnswer: { "@type": "Answer", text: faq.a },
                    name: faq.q,
                };
            }),
        }),
    );

    return (
        <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
            {/* eslint-disable-next-line react/no-danger -- JSON-LD structured data; the payload is built locally and `<` is escaped via safeJsonLd */}
            <script dangerouslySetInnerHTML={{ __html: breadcrumbLd }} type="application/ld+json" />
            {/* eslint-disable-next-line react/no-danger -- JSON-LD structured data; the payload is built locally and `<` is escaped via safeJsonLd */}
            <script dangerouslySetInnerHTML={{ __html: faqLd }} type="application/ld+json" />

            {/* vertical guide lines at the container edges, full page height */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
            />

            {/* Hero */}
            <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
                <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-36 pb-16 text-center sm:pt-44">
                    <Reveal className="flex flex-col items-center gap-6">
                        <nav aria-label="Breadcrumb" className="font-mono text-xs text-white/40">
                            <Link className="hover:text-white" to="/">
                                Home
                            </Link>{" "}
                            /{" "}
                            <Link className="hover:text-white" to="/compare">
                                Compare
                            </Link>{" "}
                            / <span className="text-white/60">vs {data.name}</span>
                        </nav>
                        <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                            Lunora{" "}
                            <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">vs</span>{" "}
                            {data.name}
                        </h1>
                        <p className="max-w-xl text-lg leading-relaxed text-white/55">{data.intro}</p>
                    </Reveal>
                </div>
            </section>

            <HatchSpacer />

            {/* Comparison table */}
            <section className="relative bg-[#0e0e11] py-14" data-nav-theme="dark">
                <div className="mx-auto max-w-4xl px-5">
                    <h2 className="mb-6 text-2xl font-semibold tracking-tight text-white">Lunora vs {data.name} at a glance</h2>
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b border-white/10 text-left">
                                <th className="py-3 pr-4 font-medium text-white/45">
                                    <span className="sr-only">Criterion</span>
                                </th>
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

            <HatchSpacer />

            {/* Summary prose */}
            <section className="relative bg-[#0e0e11] py-16" data-nav-theme="dark">
                <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5">
                    <h2 className="text-2xl font-semibold tracking-tight text-white">How Lunora and {data.name} differ</h2>
                    {data.summary.map((paragraph) => (
                        <p className="leading-relaxed text-white/55" key={paragraph.slice(0, 24)}>
                            {paragraph}
                        </p>
                    ))}
                </div>
            </section>

            <HatchSpacer />

            {/* Verdicts */}
            <section className="relative bg-[#0e0e11] py-16" data-nav-theme="dark">
                <div className="mx-auto max-w-5xl px-5">
                    <h2 className="mb-6 text-2xl font-semibold tracking-tight text-white">Where each one wins</h2>
                    <div className="grid grid-cols-1 gap-px border border-white/[0.08] md:grid-cols-2">
                        <div className="flex flex-col gap-3 border-b border-white/[0.08] bg-[#0e0e11] p-8 md:border-r md:border-b-0">
                            <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Where {data.name} wins</span>
                            <h3 className="text-xl font-semibold text-white">{data.theyWin.title}</h3>
                            <p className="text-sm leading-relaxed text-white/55">{data.theyWin.body}</p>
                        </div>
                        <div className="flex flex-col gap-3 bg-[#0e0e11] p-8">
                            <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Where Lunora differs</span>
                            <h3 className="text-xl font-semibold text-white">{data.lunoraDiffers.title}</h3>
                            <p className="text-sm leading-relaxed text-white/55">{data.lunoraDiffers.body}</p>
                        </div>
                    </div>
                </div>
            </section>

            <HatchSpacer />

            {/* FAQ */}
            <section className="relative bg-[#0e0e11] py-16" data-nav-theme="dark">
                <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5">
                    <h2 className="text-2xl font-semibold tracking-tight text-white">Frequently asked questions</h2>
                    <dl className="flex flex-col divide-y divide-white/[0.08]">
                        {data.faqs.map((faq) => (
                            <div className="flex flex-col gap-2 py-5 first:pt-0" key={faq.q}>
                                <dt className="text-base font-semibold text-white">
                                    <h3>{faq.q}</h3>
                                </dt>
                                <dd className="text-sm leading-relaxed text-white/55">{faq.a}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </section>

            <HatchSpacer />

            {/* CTA + other comparisons */}
            <section className="relative overflow-hidden bg-[#0e0e11]" data-nav-theme="dark">
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
        </div>
    );
};

export type { Cell, CompareRow, CompareSlug, Comparison, Faq, Tone, Verdict };
