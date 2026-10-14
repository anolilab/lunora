"use client";

import SiAppwrite from "@icons-pack/react-simple-icons/icons/SiAppwrite.mjs";
import SiConvex from "@icons-pack/react-simple-icons/icons/SiConvex.mjs";
import SiFirebase from "@icons-pack/react-simple-icons/icons/SiFirebase.mjs";
import SiSupabase from "@icons-pack/react-simple-icons/icons/SiSupabase.mjs";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ComponentType, FC } from "react";

import { Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";

import type { CompareSlug } from "./compare-page";
import { COMPARE_LIST, COMPARISONS } from "./data";

/**
 * Compare index — a verdict card per comparison. Both verdicts are on the card
 * so the argument is readable without the click. Shared dark frame.
 */

const MARKS: Record<CompareSlug, ComponentType<{ className?: string }>> = {
    appwrite: SiAppwrite,
    convex: SiConvex,
    firebase: SiFirebase,
    supabase: SiSupabase,
};

const CompareIndex: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        <ArticleHeader
            breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Compare" }]}
            lead="Lunora is a type-safe, real-time backend that runs on your own Cloudflare account at the edge. Honest comparisons with the alternatives, including where each one still wins."
            meta={`${String(COMPARE_LIST.length)} comparisons`}
            title="How Lunora compares"
        />

        <section className="relative bg-canvas" data-nav-theme="dark">
            <Shell className="pt-14 pb-24">
                {/* Side borders go at `lg`, where the Shell's padding falls away and the grid meets the page guides. */}
                <div className="grid grid-cols-1 gap-px border border-hairline bg-hairline md:grid-cols-2 lg:border-x-0">
                    {COMPARE_LIST.map((item) => {
                        const Mark = MARKS[item.slug];
                        const { lunoraDiffers, theyWin } = COMPARISONS[item.slug];

                        return (
                            <Link className="group flex flex-col gap-3 bg-canvas p-7 transition-colors hover:bg-wash" key={item.slug} to={`/vs/${item.slug}`}>
                                <span className="flex items-center gap-2.5">
                                    <Mark className="size-[17px] shrink-0 fill-current text-ink-faint transition-colors group-hover:text-ink" />
                                    <span className="flex-1 text-lg font-semibold tracking-tight text-ink">Lunora vs {item.name}</span>
                                    <ArrowRight className="size-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-1 group-hover:text-ink" />
                                </span>
                                <span className="text-sm leading-relaxed text-ink-muted">{item.tagline}</span>
                                <span className="mt-1 grid grid-cols-2 gap-px border border-hairline bg-hairline">
                                    <span className="flex flex-col gap-1.5 bg-canvas p-3.5">
                                        <span className="font-mono text-micro uppercase text-ink-faint">They win</span>
                                        <span className="text-xs leading-snug text-ink-faint">{theyWin.title}</span>
                                    </span>
                                    <span className="flex flex-col gap-1.5 bg-canvas p-3.5">
                                        <span className="font-mono text-micro uppercase text-accent">Lunora differs</span>
                                        <span className="text-xs leading-snug text-ink">{lunoraDiffers.title}</span>
                                    </span>
                                </span>
                            </Link>
                        );
                    })}
                </div>
            </Shell>
        </section>
    </div>
);

export default CompareIndex;
