"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Boxes, Clock, Cpu, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import type { FC } from "react";

import schemaImg from "@/assets/studio/schema.png";
import Reveal from "@/components/sections/reveal";
import { Button } from "@/components/ui/button";
import FrameworkStrip from "@/pages/home/sections/framework-strip";

/**
 * Variant 1 — "Lumen": Vercel/Geist-minimal. Centered, monochrome with a single
 * aurora accent, huge whitespace, restrained motion. Preview at /v1.
 */

const features: { description: string; icon: FC<{ className?: string }>; title: string }[] = [
    {
        description: "Types flow from server functions to the client via codegen. Rename a field, the client stops compiling.",
        icon: ShieldCheck,
        title: "End-to-end typed",
    },
    {
        description: "Queries are subscriptions. Every mutation pushes live updates to all clients over WebSocket.",
        icon: RefreshCw,
        title: "Real-time by default",
    },
    { description: "State lives in a SQLite-backed Durable Object, running close to your users at the edge.", icon: Cpu, title: "Edge-native" },
    { description: "Mutations apply instantly and queue durably offline, flushing in order on reconnect.", icon: Zap, title: "Optimistic & offline" },
    { description: "A local admin UI for schema, data, SQL, logs, and time-travel — ships with every app.", icon: Boxes, title: "Studio included" },
    { description: "A Vite plugin powers codegen, type-sync, and the dev server. Edit schema, types resync.", icon: Clock, title: "Vite-first DX" },
];

const Lumen: FC = () => (
    <div className="bg-dark-coal relative" data-theme="dark">
        {/* hero */}
        <section className="relative overflow-hidden">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[42rem]"
                style={{ background: "radial-gradient(50% 50% at 50% -8%, hsl(256 72% 68% / 0.16), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-7 px-5 pt-40 pb-16 text-center sm:pt-48">
                <Reveal className="flex flex-col items-center gap-7">
                    <span className="flex items-center gap-2 border-[0.75px] border-white/15 bg-white/[0.04] px-3 py-1 font-mono text-xs text-white/65">
                        <span className="bg-feature size-1.5 rounded-full" />
                        Open source · Built on Cloudflare
                    </span>
                    <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight text-balance text-white sm:text-6xl md:text-7xl">
                        The realtime backend, <span className="text-white/45">end-to-end typed.</span>
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-white/60">
                        Define a schema, write typed functions, and ship live queries, optimistic updates, and offline sync — globally, on Cloudflare Workers
                        and Durable Objects.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                        <Button asChild className="group h-11 gap-2 rounded-none px-6 text-base font-semibold" variant="default">
                            <Link to="/docs/$">
                                Get started
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
            </div>

            {/* product frame on a pedestal */}
            <Reveal className="relative z-10 mx-auto max-w-5xl px-5 pb-24" delay={0.15}>
                <div className="relative">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -inset-x-10 top-1/3 bottom-[-12%] -z-0 blur-3xl"
                        style={{ background: "radial-gradient(ellipse at 50% 92%, hsl(256 72% 68% / 0.22), transparent 72%)" }}
                    />
                    <div className="relative z-10 overflow-hidden rounded-xl border border-white/12 shadow-2xl shadow-black/60 ring-1 ring-white/[0.04]">
                        <img alt="Lunora Studio schema view" className="block w-full" loading="lazy" src={schemaImg} />
                    </div>
                </div>
            </Reveal>
        </section>

        <FrameworkStrip />

        {/* features */}
        <section className="mx-auto max-w-6xl px-5 py-28">
            <Reveal className="mx-auto max-w-2xl text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">Everything you need, nothing you don&apos;t.</h2>
                <p className="mt-4 text-base text-white/60">One framework — typed, reactive, and edge-native by default.</p>
            </Reveal>
            <div className="mt-16 grid grid-cols-1 gap-px overflow-hidden border border-white/[0.08] sm:grid-cols-2 lg:grid-cols-3">
                {features.map((feature, index) => {
                    const Icon = feature.icon;

                    return (
                        <Reveal
                            className="flex flex-col gap-4 bg-white/[0.015] p-8 transition-colors hover:bg-white/[0.03]"
                            delay={(index % 3) * 0.05}
                            key={feature.title}
                        >
                            <Icon className="text-feature size-5" />
                            <h3 className="text-base font-medium text-white">{feature.title}</h3>
                            <p className="text-sm leading-relaxed text-white/55">{feature.description}</p>
                        </Reveal>
                    );
                })}
            </div>
        </section>

        {/* closing CTA */}
        <section className="relative overflow-hidden border-t border-white/[0.06]">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-0"
                style={{ background: "radial-gradient(60% 80% at 50% 120%, hsl(256 72% 68% / 0.14), transparent 70%)" }}
            />
            <Reveal className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-28 text-center">
                <h2 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">Build realtime, on the edge.</h2>
                <p className="max-w-lg text-base text-white/60">Ship a typed, live backend in an afternoon — no infrastructure to manage.</p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button asChild className="group h-11 gap-2 rounded-none px-6 text-base font-semibold" variant="default">
                        <Link to="/docs/$">
                            Get started
                            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
                        </Link>
                    </Button>
                    <code className="border-[0.75px] border-white/12 bg-white/[0.03] px-4 py-2.5 font-mono text-sm text-white/70">
                        $ npx lunora init my-app
                    </code>
                </div>
            </Reveal>
        </section>
    </div>
);

export default Lumen;
