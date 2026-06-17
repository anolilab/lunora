"use client";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { FC } from "react";

import sqlImg from "@/assets/studio/sql-editor.png";
import timeTravelImg from "@/assets/studio/time-travel.png";
import Reveal from "@/components/sections/reveal";
import { Button } from "@/components/ui/button";
import FrameworkStrip from "@/pages/home/sections/framework-strip";

/**
 * Variant 4 — "Folio": editorial / magazine. Oversized typography, an
 * asymmetric ruled layout, and numbered chapters. Preview at /v4.
 */

const CHAPTERS: { body: string; index: string; title: string }[] = [
    {
        body: "Define a schema and write functions. Codegen syncs types from server to client — rename a field and the client stops compiling. No DTOs, no drift.",
        index: "01",
        title: "Typed, end to end",
    },
    {
        body: "Queries are subscriptions. Every mutation pushes live updates to all connected clients over WebSocket — the realtime layer is the default, not an add-on.",
        index: "02",
        title: "Realtime, not requested",
    },
    {
        body: "State lives in SQLite-backed Durable Objects at the edge. Shard by user, tenant, or room with a single chained call; go global to replicate reads.",
        index: "03",
        title: "Edge-native by design",
    },
    {
        body: "A studio for schema, data, SQL, logs, and time-travel ships with every app. A Vite plugin powers codegen, type-sync, and the dev server end to end.",
        index: "04",
        title: "Batteries included",
    },
];

const Folio: FC = () => (
    <div className="bg-dark-coal relative" data-theme="dark">
        {/* editorial hero */}
        <section className="relative overflow-hidden border-b border-white/[0.08]">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[44rem]"
                style={{ background: "radial-gradient(40% 50% at 18% 0%, hsl(330 80% 64% / 0.12), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto max-w-6xl px-5 pt-40 pb-20 sm:pt-52">
                <Reveal className="flex items-center justify-between gap-4 border-b border-white/[0.1] pb-5 font-mono text-xs tracking-[0.18em] text-white/45 uppercase">
                    <span>The realtime backend</span>
                    <span className="hidden sm:inline">Cloudflare · Workers · Durable Objects</span>
                    <span>Vol. 01</span>
                </Reveal>
                <Reveal className="mt-10" delay={0.05}>
                    <h1 className="text-[clamp(2.75rem,9vw,7rem)] leading-[0.92] font-semibold tracking-[-0.03em] text-balance text-white">
                        Build the backend
                        <br />
                        <span className="text-white/40">like it&apos;s the </span>
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">frontend.</span>
                    </h1>
                </Reveal>
                <div className="mt-12 grid gap-10 border-t border-white/[0.1] pt-10 lg:grid-cols-[1.4fr_1fr]">
                    <Reveal delay={0.1}>
                        <p className="max-w-xl text-xl leading-relaxed text-white/65">
                            Lunora turns a typed function into a live-syncing API on the global edge. Schema, realtime, storage, and a studio — one framework,
                            no infrastructure to manage.
                        </p>
                    </Reveal>
                    <Reveal className="flex flex-col items-start gap-4 lg:items-end" delay={0.15}>
                        <Button asChild className="group h-12 gap-2 rounded-none px-7 text-base font-semibold" variant="default">
                            <Link to="/docs/$">
                                Start reading the docs
                                <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                            </Link>
                        </Button>
                        <code className="font-mono text-sm text-white/50">$ npx lunora init my-app</code>
                    </Reveal>
                </div>
            </div>
        </section>

        {/* full-bleed product plate */}
        <section className="relative overflow-hidden border-b border-white/[0.08]">
            <Reveal className="mx-auto max-w-6xl px-5 py-20">
                <div className="relative overflow-hidden rounded-xl border border-white/12 shadow-2xl shadow-black/60 ring-1 ring-white/[0.04]">
                    <img alt="Lunora Studio SQL editor" className="block w-full" loading="lazy" src={sqlImg} />
                </div>
                <p className="mt-4 font-mono text-xs tracking-[0.16em] text-white/35 uppercase">Fig. 1 — Lunora Studio, querying a live edge database</p>
            </Reveal>
        </section>

        <FrameworkStrip />

        {/* numbered chapters */}
        <section className="mx-auto max-w-6xl px-5 py-24">
            <Reveal className="mb-4 font-mono text-xs tracking-[0.18em] text-white/45 uppercase">Contents</Reveal>
            <div className="border-t border-white/[0.1]">
                {CHAPTERS.map((chapter, index) => (
                    <Reveal
                        className="group grid items-baseline gap-4 border-b border-white/[0.1] py-9 transition-colors hover:bg-white/[0.015] md:grid-cols-[auto_1fr_1.4fr] md:gap-10"
                        delay={(index % 2) * 0.05}
                        key={chapter.index}
                    >
                        <span className="font-mono text-sm text-white/30 tabular-nums">{chapter.index}</span>
                        <h3 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{chapter.title}</h3>
                        <p className="max-w-xl text-base leading-relaxed text-white/55">{chapter.body}</p>
                    </Reveal>
                ))}
            </div>
        </section>

        {/* time-travel plate */}
        <section className="relative overflow-hidden border-t border-white/[0.08]">
            <Reveal className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[1fr_1.2fr]">
                <div className="flex flex-col gap-5">
                    <span className="font-mono text-xs tracking-[0.18em] text-white/45 uppercase">Time travel</span>
                    <h2 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">Rewind your data to any moment.</h2>
                    <p className="max-w-md text-base text-white/55 md:text-lg">
                        Every shard is a SQLite database you can rewind — restore to any point in the last 30 days from a bookmark, with no extra
                        infrastructure.
                    </p>
                </div>
                <div className="relative overflow-hidden rounded-xl border border-white/12 shadow-2xl shadow-black/60 ring-1 ring-white/[0.04]">
                    <img alt="Lunora Studio time-travel view" className="block w-full" loading="lazy" src={timeTravelImg} />
                </div>
            </Reveal>
        </section>

        {/* colophon CTA */}
        <section className="relative overflow-hidden border-t border-white/[0.08]">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-0"
                style={{ background: "radial-gradient(60% 80% at 50% 120%, hsl(330 80% 64% / 0.12), transparent 70%)" }}
            />
            <Reveal className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 py-28 text-center">
                <h2 className="text-[clamp(2.25rem,6vw,4rem)] leading-[0.96] font-semibold tracking-[-0.02em] text-balance text-white">
                    Your next backend is a function away.
                </h2>
                <p className="max-w-lg text-base text-white/60">Open source, deployed to your own Cloudflare account, with no infrastructure to manage.</p>
                <Button asChild className="group h-12 gap-2 rounded-none px-7 text-base font-semibold" variant="default">
                    <Link to="/docs/$">
                        Get started
                        <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </Link>
                </Button>
            </Reveal>
        </section>
    </div>
);

export default Folio;
