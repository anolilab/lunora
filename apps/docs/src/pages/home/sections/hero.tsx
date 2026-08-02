"use client";

import { ArrowRight, Check, Copy } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import AgentPanel from "@/components/sections/agent-panel";
import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import posthog from "@/lib/posthog";

/**
 * Hero: a centered headline + CTAs over a faint scenic backdrop, then the
 * interactive panel (code tabs + live todo + reactive table) below. Lunora
 * brand (Geist + aurora accents).
 */

const InstallCommand: FC = () => {
    const [copied, setCopied] = useState(false);

    const copy = () => {
        const run = async () => {
            try {
                await navigator.clipboard.writeText("npx lunorash@alpha init my-app");
            } catch {
                // Permission denied, or no secure context. Nothing was copied,
                // so neither the check mark nor the event should claim it was.
                return;
            }

            posthog.capture("install_command_copied", { location: "home_hero" });
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1500);
        };

        void run();
    };

    return (
        <button
            className="group flex w-fit items-center gap-3 border border-white/12 px-4 py-2 font-mono text-sm text-white/60 transition-colors hover:border-white/25 hover:text-white"
            onClick={copy}
            type="button"
        >
            <span className="text-white/30 select-none">$</span>
            npx lunorash@alpha init my-app
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-3.5 text-white/35 transition-colors group-hover:text-white/60" />}
        </button>
    );
};

const Hero: FC = () => (
    <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
        <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center gap-6 px-5 pt-40 pb-14 text-center sm:pt-48">
            <p className="sr-only">
                Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer experience. Define a
                schema and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live subscriptions, optimistic
                updates, and an offline queue — types sync from server to client automatically via codegen.
            </p>
            <Reveal className="flex flex-col items-center gap-6">
                <span className="flex items-center gap-2 border border-white/12 px-3 py-1 font-mono text-xs text-white/60">
                    <span className="size-1.5 bg-sky-sapphire" />
                    The realtime backend for Cloudflare
                </span>
                <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                    Realtime backends, in a few lines of{" "}
                    <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">code.</span>
                </h1>
                <p className="max-w-xl text-lg leading-relaxed text-white/55">
                    Define a schema, write a function — Lunora gives you a typed, live-syncing API on Cloudflare&apos;s edge. No glue code, no infrastructure to
                    manage.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <Pill primary>
                        Start building
                        <ArrowRight className="size-4" />
                    </Pill>
                    <Pill href="https://github.com/anolilab/lunora">View on GitHub</Pill>
                </div>
                <InstallCommand />
            </Reveal>
        </div>

        <Reveal className="relative z-10 pb-20">
            <AgentPanel />
        </Reveal>
    </section>
);

export default Hero;
