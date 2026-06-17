"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Boxes, Clock, Database, Globe, Radio, ShieldCheck, Terminal } from "lucide-react";
import type { FC, ReactNode } from "react";

import schemaImg from "@/assets/studio/schema.png";
import Reveal from "@/components/sections/reveal";
import { Button } from "@/components/ui/button";
import FrameworkStrip from "@/pages/home/sections/framework-strip";

/**
 * Variant 3 — "Nova": Supabase-inspired. Dark and code-forward — a split hero
 * with a live code panel, then a feature bento of mixed-size cells. Preview at /v3.
 */

const CODE_LINES: { text: string; tone?: "kw" | "fn" | "str" | "cm" | "punc" }[][] = [
    [{ text: "export const ", tone: "kw" }, { text: "sendMessage" }, { text: " = mutation", tone: "fn" }],
    [{ text: "  .input({ body: ", tone: "punc" }, { text: "v.string()", tone: "fn" }, { text: " })" }],
    [{ text: "  .mutation(", tone: "fn" }, { text: "async " }, { text: "({ ctx, args }) => {", tone: "punc" }],
    [{ text: "    return ctx.db." }, { text: "insert", tone: "fn" }, { text: "(" }, { text: '"messages"', tone: "str" }, { text: ", {" }],
    [{ text: "      body: args.body, sentAt: " }, { text: "Date.now()", tone: "fn" }],
    [{ text: "    });" }],
    [{ text: "  });" }],
];

const TONE: Record<string, string> = {
    cm: "text-white/35",
    fn: "text-sky-sapphire",
    kw: "text-royal-amethyst",
    punc: "text-white/45",
    str: "text-crimson-energy",
};

const CodePanel: FC = () => (
    <div className="overflow-hidden rounded-xl border border-white/[0.1] bg-[hsl(240_18%_4%)] shadow-2xl shadow-black/60 ring-1 ring-white/[0.04]">
        <div className="flex items-center gap-2 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="ml-2 font-mono text-xs text-white/40">lunora/sendMessage.ts</span>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
            <code>
                {CODE_LINES.map((line, index) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <div className="whitespace-pre" key={index}>
                        {line.map((token, tokenIndex) => (
                            // eslint-disable-next-line react/no-array-index-key
                            <span className={token.tone ? TONE[token.tone] : "text-white/80"} key={tokenIndex}>
                                {token.text}
                            </span>
                        ))}
                        {line.length === 0 ? " " : null}
                    </div>
                ))}
            </code>
        </pre>
    </div>
);

const BentoCell: FC<{ children?: ReactNode; className?: string; copy: string; icon: FC<{ className?: string }>; title: string }> = ({
    children,
    className,
    copy,
    icon: Icon,
    title,
}) => (
    <Reveal className={`group relative flex flex-col gap-4 bg-white/[0.015] p-7 transition-colors hover:bg-white/[0.03] ${className ?? ""}`}>
        <Icon className="text-feature size-5" />
        <div className="flex flex-col gap-2">
            <h3 className="text-base font-medium text-white">{title}</h3>
            <p className="text-sm leading-relaxed text-white/55">{copy}</p>
        </div>
        {children}
    </Reveal>
);

const Nova: FC = () => (
    <div className="bg-dark-coal relative" data-theme="dark">
        {/* split hero */}
        <section className="relative overflow-hidden">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[40rem]"
                style={{ background: "radial-gradient(45% 50% at 80% 0%, hsl(186 84% 56% / 0.14), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-14 px-5 pt-40 pb-24 sm:pt-48 lg:grid-cols-2">
                <Reveal className="flex flex-col gap-6">
                    <span className="flex w-fit items-center gap-2 border-[0.75px] border-white/15 bg-white/[0.04] px-3 py-1 font-mono text-xs text-white/65">
                        <span className="bg-feature size-1.5 rounded-full" />
                        Open source · Built on Cloudflare
                    </span>
                    <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                        The backend is just <span className="text-white/45">a function.</span>
                    </h1>
                    <p className="max-w-md text-lg leading-relaxed text-white/60">
                        Write a typed function, get a live-syncing API on the edge. Lunora handles the realtime, the storage, and the types — end to end.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
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
                <Reveal delay={0.15}>
                    <CodePanel />
                </Reveal>
            </div>
        </section>

        <FrameworkStrip />

        {/* feature bento */}
        <section className="mx-auto max-w-6xl px-5 py-28">
            <Reveal className="mx-auto max-w-2xl text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">A full backend, batteries included.</h2>
                <p className="mt-4 text-base text-white/60">Realtime, storage, auth, and a studio — typed and edge-native by default.</p>
            </Reveal>
            <div className="mt-16 grid grid-cols-1 gap-px overflow-hidden border border-white/[0.08] md:grid-cols-3">
                <BentoCell
                    className="md:col-span-2"
                    copy="Queries are subscriptions. Every mutation pushes live updates to all connected clients over WebSocket — no extra code, no polling."
                    icon={Radio}
                    title="Realtime by default"
                >
                    <div className="relative mt-3 overflow-hidden rounded-lg border border-white/[0.08]">
                        <img alt="Lunora Studio schema view" className="block w-full opacity-90" loading="lazy" src={schemaImg} />
                    </div>
                </BentoCell>
                <BentoCell
                    copy="Types flow from server functions to the client via codegen. Rename a field and the client stops compiling."
                    icon={ShieldCheck}
                    title="End-to-end typed"
                />
                <BentoCell
                    copy="State lives in SQLite-backed Durable Objects, running close to your users at the edge."
                    icon={Database}
                    title="Edge-native data"
                />
                <BentoCell
                    copy="Shard by user, tenant, or room with one chained call. Go global to replicate reads across regions."
                    icon={Globe}
                    title="Scale by sharding"
                />
                <BentoCell
                    copy="Rewind any shard to any moment in the last 30 days. Point-in-time restore with no extra infra."
                    icon={Clock}
                    title="Time travel"
                />
                <BentoCell
                    className="md:col-span-2"
                    copy="A local admin UI for schema, data, SQL, logs, and time-travel ships with every app. A Vite plugin powers codegen, type-sync, and the dev server."
                    icon={Boxes}
                    title="Studio + Vite-first DX"
                >
                    <div className="mt-3 flex items-center gap-2 font-mono text-xs text-white/40">
                        <Terminal className="size-3.5" />$ lunora dev — studio at localhost:5173/_studio
                    </div>
                </BentoCell>
            </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden border-t border-white/[0.06]">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-0"
                style={{ background: "radial-gradient(60% 80% at 50% 120%, hsl(186 84% 56% / 0.14), transparent 70%)" }}
            />
            <Reveal className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-28 text-center">
                <h2 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">Start with a function. Ship a backend.</h2>
                <p className="max-w-lg text-base text-white/60">Open source, deployed to your own Cloudflare account, with no infrastructure to manage.</p>
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

export default Nova;
