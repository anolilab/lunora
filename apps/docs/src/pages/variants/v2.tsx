"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { FC } from "react";

import schemaImg from "@/assets/studio/schema.png";
import sqlImg from "@/assets/studio/sql-editor.png";
import timeTravelImg from "@/assets/studio/time-travel.png";
import FeatureScene from "@/components/sections/feature-scene";
import Reveal from "@/components/sections/reveal";
import { Button } from "@/components/ui/button";
import FrameworkStrip from "@/pages/home/sections/framework-strip";

/**
 * Variant 2 — "Prism": Stripe-inspired. A vivid aurora gradient hero with a
 * tilted product frame, then alternating product scenes. Preview at /v2.
 */

const Prism: FC = () => (
    <div className="bg-dark-coal relative" data-theme="dark">
        {/* gradient hero */}
        <section className="relative overflow-hidden">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-0"
                style={{
                    background:
                        "radial-gradient(60% 60% at 12% 0%, hsl(186 84% 56% / 0.20), transparent 60%), radial-gradient(55% 60% at 60% -10%, hsl(256 72% 68% / 0.26), transparent 60%), radial-gradient(50% 55% at 100% 10%, hsl(330 80% 64% / 0.18), transparent 60%)",
                }}
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
            />
            <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 px-5 pt-40 pb-24 sm:pt-48 lg:grid-cols-[1fr_0.95fr]">
                <Reveal className="flex flex-col gap-6">
                    <span className="flex w-fit items-center gap-2 rounded-full border-[0.75px] border-white/15 bg-white/[0.04] px-3 py-1 font-mono text-xs text-white/70 backdrop-blur-sm">
                        <span className="bg-feature size-1.5 rounded-full" />
                        The realtime backend for Cloudflare
                    </span>
                    <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                        Ship realtime apps,{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">
                            without the backend.
                        </span>
                    </h1>
                    <p className="max-w-md text-lg leading-relaxed text-white/60">
                        Define a schema, write a function — get a typed, live-syncing API on the global edge. No glue code, no infrastructure to manage.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <Button asChild className="group h-11 gap-2 rounded-none px-6 text-base font-semibold" variant="default">
                            <Link to="/docs/$">
                                Start building
                                <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
                            </Link>
                        </Button>
                        <Button
                            asChild
                            className="h-11 gap-2 rounded-none border-white/20 bg-transparent px-6 text-base font-medium text-white hover:border-white/35 hover:bg-white/[0.06]"
                            variant="outline"
                        >
                            <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                                View on GitHub
                            </a>
                        </Button>
                    </div>
                </Reveal>

                {/* tilted product frame */}
                <Reveal className="relative" delay={0.15}>
                    <div className="relative lg:rotate-[1.5deg] lg:transition-transform lg:duration-500 lg:hover:rotate-0">
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute -inset-6 -z-0 blur-3xl"
                            style={{ background: "radial-gradient(ellipse at 50% 50%, hsl(256 72% 68% / 0.30), transparent 70%)" }}
                        />
                        <div className="relative z-10 overflow-hidden rounded-xl border border-white/12 shadow-2xl shadow-black/60 ring-1 ring-white/[0.06]">
                            <img alt="Lunora Studio SQL editor" className="block w-full" loading="lazy" src={sqlImg} />
                        </div>
                    </div>
                </Reveal>
            </div>
        </section>

        <FrameworkStrip />

        {/* alternating scenes */}
        <section className="mx-auto max-w-6xl px-5 py-28">
            <div className="flex flex-col gap-24 lg:gap-36">
                <FeatureScene
                    alt="Lunora Studio schema view"
                    bullets={[
                        "Shard-local tables in Durable Object SQLite",
                        "Global tables replicated through D1",
                        "Edit the schema — codegen reruns, types stay in sync",
                    ]}
                    copy="Declare your tables once and Lunora generates a typed data model shared by server and client — shard-local state in a Durable Object, global tables in D1."
                    eyebrow="Schema"
                    image={schemaImg}
                    title="Your schema is the source of truth."
                />
                <FeatureScene
                    alt="Lunora Studio time-travel view"
                    bullets={["Point-in-time restore, any moment in 30 days", "Bookmark-based, in-place recovery", "Snapshot backup tier for older state"]}
                    copy="Every shard is a SQLite database you can rewind — restore to any moment in the last 30 days from a bookmark, with no extra infrastructure."
                    eyebrow="Time Travel"
                    image={timeTravelImg}
                    reverse
                    title="Rewind your data to any moment."
                />
            </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden border-t border-white/[0.06]">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-0"
                style={{
                    background:
                        "radial-gradient(60% 90% at 50% 120%, hsl(256 72% 68% / 0.20), transparent 65%), radial-gradient(40% 70% at 20% 120%, hsl(186 84% 56% / 0.12), transparent 65%)",
                }}
            />
            <Reveal className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-28 text-center">
                <h2 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">From schema to live app in minutes.</h2>
                <p className="max-w-lg text-base text-white/60">
                    Start free, deploy to your own Cloudflare account, and scale without managing infrastructure.
                </p>
                <Button asChild className="group h-11 gap-2 rounded-none px-6 text-base font-semibold" variant="default">
                    <Link to="/docs/$">
                        Get started
                        <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
                    </Link>
                </Button>
            </Reveal>
        </section>
    </div>
);

export default Prism;
