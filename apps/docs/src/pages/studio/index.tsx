"use client";

import { ArrowRight, Check, Database, GitBranch, LayoutDashboard, ShieldCheck, TerminalSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import dashboardsImg from "@/assets/studio/dark/dashboards.png";
import dataImg from "@/assets/studio/dark/data.png";
import homeImg from "@/assets/studio/dark/home.png";
import schemaImg from "@/assets/studio/dark/schema.png";
import sqlImg from "@/assets/studio/dark/sql-editor.png";
import timeTravelImg from "@/assets/studio/dark/time-travel.png";
import workflowsImg from "@/assets/studio/dark/workflows.png";
import HatchSpacer from "@/components/sections/hatch-spacer";
import { Pill, SectionHead } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import { cn } from "@/lib/utils";

/**
 * Lunora Studio landing page — a showcase of the local admin UI in the shared
 * dark Axon frame (charcoal, full-width dividers, vertical guides, hatch
 * spacers). Screenshots are dark-mode captures from src/assets/studio/dark.
 */

const Shot: FC<{ alt: string; src: string }> = ({ alt, src }) => (
    <div className="overflow-hidden">
        <img alt={alt} className="block w-full" loading="lazy" src={src} />
    </div>
);

interface FeatureBlock {
    desc: string;
    eyebrow: string;
    flip?: boolean;
    points: string[];
    src: string;
    title: string;
}

const features: FeatureBlock[] = [
    {
        desc: "See every table the way Lunora does — shard-local SQLite tables and globally replicated D1 tables, with their columns, indexes, and relations, all derived from defineSchema.",
        eyebrow: "Schema",
        points: [
            "Shard-local and global D1 tables side by side",
            "Add tables, columns, and indexes, then rerun codegen",
            "Table list or interactive relation graph",
        ],
        src: schemaImg,
        title: "Your data model, at a glance",
    },
    {
        desc: "Browse and edit live rows straight from the edge. Switch storage tier and shard to inspect exactly the data a given user or room sees.",
        eyebrow: "Data",
        flip: true,
        points: ["Pick a storage tier and shard key", "Live rows streamed from your Durable Objects", "Inline editing against the real database"],
        src: dataImg,
        title: "Browse data where it lives",
    },
    {
        desc: "Run SQL against any shard or your global D1 tables without leaving the studio — perfect for one-off lookups, debugging, and quick fixes.",
        eyebrow: "SQL editor",
        points: ["Query a single shard or the global tier", "Full SQLite syntax over your live data", "Results rendered as a sortable table"],
        src: sqlImg,
        title: "A SQL console for the edge",
    },
    {
        desc: "Every shard is a SQLite database you can rewind. Restore to any moment in the last 30 days by timestamp or bookmark — no extra infrastructure required.",
        eyebrow: "Time travel",
        flip: true,
        points: ["Point-in-time restore for any shard", "Recover by ISO time or explicit bookmark", "Restart the shard so recovery applies instantly"],
        src: timeTravelImg,
        title: "Rewind to any moment",
    },
];

const FeatureRow: FC<{ feature: FeatureBlock }> = ({ feature }) => (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <Reveal className={cn("flex flex-col gap-5", feature.flip && "lg:order-2")}>
            <span className="font-mono text-xs tracking-[0.18em] text-ink-faint uppercase">{feature.eyebrow}</span>
            <h3 className="text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl">{feature.title}</h3>
            <p className="text-base leading-relaxed text-ink-muted">{feature.desc}</p>
            <ul className="mt-1 flex flex-col gap-3">
                {feature.points.map((point) => (
                    <li className="flex items-start gap-3 text-sm text-ink-muted" key={point}>
                        <Check className="mt-0.5 size-4 shrink-0 text-sky-sapphire" />
                        {point}
                    </li>
                ))}
            </ul>
        </Reveal>
        <Reveal className={cn(feature.flip && "lg:order-1")}>
            <Shot alt={`Lunora Studio — ${feature.title}`} src={feature.src} />
        </Reveal>
    </div>
);

interface MoreItem {
    desc: string;
    icon: ReactNode;
    title: string;
}

const more: MoreItem[] = [
    {
        desc: "Live metrics for requests, errors, latency, and database size — composed into dashboards.",
        icon: <LayoutDashboard className="size-5" />,
        title: "Dashboards",
    },
    {
        desc: "Inspect functions declared with defineWorkflow and run as durable Cloudflare Workflows.",
        icon: <GitBranch className="size-5" />,
        title: "Workflows",
    },
    { desc: "Static schema and query lints surface unindexed FKs, duplicate indexes, and more.", icon: <ShieldCheck className="size-5" />, title: "Advisors" },
    {
        desc: "Export and import data, replay migrations, and inspect every Lunora function and route.",
        icon: <Database className="size-5" />,
        title: "Migrations & data",
    },
];

const StudioLanding: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        {/* vertical guide lines */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-hairline lg:block"
        />

        {/* hero */}
        <section className="relative border-t border-hairline" data-nav-theme="dark">
            <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-40 pb-12 text-center sm:pt-44">
                <Reveal className="flex flex-col items-center gap-6">
                    <span className="flex items-center gap-2 border border-hairline px-3 py-1 font-mono text-xs text-ink-muted">
                        <span className="size-1.5 bg-sky-sapphire" />
                        Lunora Studio
                    </span>
                    <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-ink sm:text-6xl">
                        Your backend,{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">
                            fully visible.
                        </span>
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-ink-muted">
                        A local admin UI for your schema, data, SQL, logs, and advisors — running against your live edge database. It ships with every Lunora
                        app, no setup required.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2.5">
                        <Pill primary to="/docs/getting-started">
                            Get started
                            <ArrowRight className="size-4" />
                        </Pill>
                        <Pill to="/packages/studio">Studio package</Pill>
                    </div>
                    <p className="flex items-center gap-2 font-mono text-sm text-ink-faint">
                        <TerminalSquare className="size-4" />
                        opens automatically with <span className="text-ink-muted">lunora dev</span>
                    </p>
                </Reveal>
            </div>
            <Reveal className="relative z-10 mx-auto max-w-6xl px-5 lg:px-0">
                <Shot alt="Lunora Studio — overview" src={homeImg} />
            </Reveal>
        </section>

        <HatchSpacer />

        {/* feature rows */}
        <section className="border-t border-hairline" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-20 lg:px-0">
                <SectionHead
                    eyebrow="Everything in one place"
                    subtitle="Studio reads your schema and talks to your Durable Objects directly — so what you see is exactly what your app sees."
                    title="One window into your edge data"
                />
                <div className="mt-20 flex flex-col gap-24">
                    {features.map((feature) => (
                        <FeatureRow feature={feature} key={feature.title} />
                    ))}
                </div>
            </div>
        </section>

        <HatchSpacer />

        {/* secondary showcase */}
        <section className="border-t border-hairline" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-20 lg:px-0">
                <div className="grid gap-10 lg:grid-cols-2 lg:gap-14">
                    <Reveal className="flex flex-col gap-5">
                        <span className="flex items-center gap-2 font-mono text-xs tracking-[0.18em] text-ink-faint uppercase">
                            <LayoutDashboard className="size-3.5 text-royal-amethyst" />
                            Dashboards
                        </span>
                        <h3 className="text-2xl font-semibold tracking-tight text-ink">Metrics, the moment you need them</h3>
                        <p className="text-base leading-relaxed text-ink-muted">
                            Requests, errors, latency, and live connections — surfaced on a home overview and arranged into dashboards.
                        </p>
                        <Shot alt="Lunora Studio — dashboards" src={dashboardsImg} />
                    </Reveal>
                    <Reveal className="flex flex-col gap-5">
                        <span className="flex items-center gap-2 font-mono text-xs tracking-[0.18em] text-ink-faint uppercase">
                            <GitBranch className="size-3.5 text-crimson-energy" />
                            Workflows
                        </span>
                        <h3 className="text-2xl font-semibold tracking-tight text-ink">Observe durable workflows</h3>
                        <p className="text-base leading-relaxed text-ink-muted">
                            Workflows declared in code run as durable Cloudflare Workflows. Start an instance and watch its status from the studio.
                        </p>
                        <Shot alt="Lunora Studio — workflows" src={workflowsImg} />
                    </Reveal>
                </div>
            </div>
        </section>

        <HatchSpacer />

        {/* more in the box */}
        <section className="border-t border-hairline" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-20 lg:px-0">
                <SectionHead eyebrow="And more" subtitle="The studio grows with your app — every Lunora capability shows up here." title="More in the box" />
                <div className="mt-12 grid gap-px border border-hairline sm:grid-cols-2 lg:grid-cols-4 lg:border-x-0">
                    {more.map((item) => (
                        <div className="flex flex-col gap-3 bg-wash p-8" key={item.title}>
                            <span className="flex size-10 items-center justify-center border border-hairline bg-wash text-ink-muted">{item.icon}</span>
                            <h3 className="text-base font-semibold text-ink">{item.title}</h3>
                            <p className="text-sm leading-relaxed text-ink-faint">{item.desc}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>

        <HatchSpacer />

        {/* CTA */}
        <section className="border-t border-hairline" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 pt-24 lg:px-0">
                <SectionHead
                    eyebrow="Zero setup"
                    subtitle="Studio runs locally with the Lunora CLI and Vite plugin — always pointed at your live edge database. Nothing to install, nothing to deploy."
                    title="Open it with one command"
                />
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                    <Pill primary to="/docs/getting-started">
                        Get started
                        <ArrowRight className="size-4" />
                    </Pill>
                    <Pill to="/packages/studio">Read the docs</Pill>
                </div>
            </div>
        </section>

        <HatchSpacer />
    </div>
);

export default StudioLanding;
