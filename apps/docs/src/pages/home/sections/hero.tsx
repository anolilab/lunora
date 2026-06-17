"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight, Package, Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import background from "@/assets/images/background_hero.jpg";
import Section from "@/components/sections/section";
import WordRotate from "@/components/ui/word-rotate";
import { cn } from "@/lib/utils";

interface PackageDemo {
    code: string[];
    label: string;
    output: { color?: string; delay: number; text: string }[];
    pkg: string;
}

const packageDemos: PackageDemo[] = [
    {
        code: [
            "import { defineSchema, defineTable, v }",
            '  from "lunora/server";',
            "",
            "export default defineSchema({",
            "  messages: defineTable({",
            "    body: v.string(),",
            "    author: v.string(),",
            "  }),",
            "});",
        ],
        label: "schema",
        output: [
            { delay: 80, text: "" },
            { color: "text-emerald-400/80", delay: 200, text: "  \u25CF codegen  _generated/api.ts" },
            { color: "text-emerald-400/80", delay: 300, text: "  \u25CF codegen  _generated/dataModel.ts" },
            { color: "text-sky-sapphire/80", delay: 400, text: "  \u25CF types    messages \u2192 client" },
            { color: "text-emerald-400/80", delay: 200, text: "  \u25CF ready    end-to-end typed" },
        ],
        pkg: "lunora/schema.ts",
    },
    {
        code: [
            "import { query, mutation, v }",
            '  from "lunora/server";',
            "",
            "export const list = query({",
            '  handler: (ctx) => ctx.db.query("messages"),',
            "});",
            "",
            "export const send = mutation({",
            "  args: { body: v.string() },",
            "  handler: (ctx, { body }) =>",
            '    ctx.db.insert("messages", { body }),',
            "});",
        ],
        label: "functions",
        output: [
            { delay: 80, text: "" },
            { color: "text-white/45", delay: 200, text: "  api.messages.list   query" },
            { color: "text-white/45", delay: 100, text: "  api.messages.send   mutation" },
            { color: "text-sky-sapphire/80", delay: 200, text: "  served from Durable Object" },
            { color: "text-emerald-400/80", delay: 150, text: "  live subscriptions enabled" },
        ],
        pkg: "lunora/messages.ts",
    },
    {
        code: [
            'import { useQuery } from "@lunora/react";',
            'import { api } from "./_generated/api";',
            "",
            "function Chat() {",
            "  const messages = useQuery(api.messages.list);",
            "  return messages?.map((m) =>",
            "    <p key={m._id}>{m.body}</p>",
            "  );",
            "}",
        ],
        label: "react",
        output: [
            { delay: 80, text: "" },
            { color: "text-white/45", delay: 150, text: "  rendering live data\u2026" },
            { color: "text-emerald-400/80", delay: 150, text: "  \u25CF Hello from the edge" },
            { color: "text-emerald-400/80", delay: 100, text: "  \u25CF New message just synced" },
            { color: "text-sky-sapphire/80", delay: 200, text: "  \u21BB re-renders on every mutation" },
        ],
        pkg: "@lunora/react",
    },
    {
        code: [
            'import { mutation, v } from "lunora/server";',
            "",
            "export const like = mutation({",
            '  args: { id: v.id("messages") },',
            "  handler: (ctx, { id }) =>",
            "    ctx.db.patch(id, { liked: true }),",
            "});",
            "// client: optimistic + offline queue",
        ],
        label: "optimistic",
        output: [
            { delay: 80, text: "" },
            { color: "text-sky-sapphire/80", delay: 200, text: "  applied optimistically  \u2713" },
            { color: "text-yellow-400/70", delay: 200, text: "  offline \u2192 queued" },
            { color: "text-emerald-400/80", delay: 200, text: "  reconnect \u2192 flushed & confirmed" },
        ],
        pkg: "@lunora/client",
    },
];

const CodeLine: FC<{ content: string }> = ({ content }) => {
    if (!content.trim()) {
        return <span>{"\u00A0"}</span>;
    }

    return (
        <span>
            {content.split(/(\s+)/).map((segment, index) => {
                if (/^\s+$/.test(segment)) {
                    return <span key={index}>{segment}</span>;
                }

                if (!segment) {
                    return null;
                }

                const isKeyword = /^(import|from|const|await|export|async|function|type)$/.test(segment);
                const isString = /^["'`]/.test(segment);
                const isPunctuation = /^[{}()[\];,=>:]+$/.test(segment);
                const isNumber = /^\d+$/.test(segment);
                const isBoolean = /^(true|false|null|undefined)$/.test(segment);

                let colorClass = "text-white/55";

                if (isKeyword) colorClass = "text-crimson-energy/70";
                else if (isString) colorClass = "text-sky-sapphire/75";
                else if (isPunctuation) colorClass = "text-white/20";
                else if (isNumber || isBoolean) colorClass = "text-sky-sapphire/60";

                return (
                    <span className={colorClass} key={index}>
                        {segment}
                    </span>
                );
            })}
        </span>
    );
};

const PackageShowcase: FC = () => {
    const [activeIndex, setActiveIndex] = useState(0);
    const [visibleLines, setVisibleLines] = useState(0);
    const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const demo = packageDemos[activeIndex];

    const clearTimeouts = useCallback(() => {
        timeoutsRef.current.forEach(clearTimeout);
        timeoutsRef.current = [];
    }, []);

    const revealOutput = useCallback(
        (index: number) => {
            clearTimeouts();
            setVisibleLines(0);

            const d = packageDemos[index];

            if (!d) {
                return;
            }

            const reveal = (lineIndex: number) => {
                if (lineIndex <= d.output.length) {
                    setVisibleLines(lineIndex);

                    if (lineIndex < d.output.length) {
                        const delay = d.output[lineIndex].delay ?? 100;
                        const id = setTimeout(() => {
                            reveal(lineIndex + 1);
                        }, delay);

                        timeoutsRef.current.push(id);
                    }
                }
            };

            const id = setTimeout(() => {
                reveal(0);
            }, 400);

            timeoutsRef.current.push(id);
        },
        [clearTimeouts],
    );

    useEffect(() => {
        revealOutput(activeIndex);

        return clearTimeouts;
    }, [activeIndex, revealOutput, clearTimeouts]);

    return (
        <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="relative w-full py-5 pl-10"
            initial={{ opacity: 0, y: 30 }}
            style={{ backgroundImage: `url(${background})` }}
            transition={{ delay: 1, duration: 0.8, ease: "easeOut" }}
        >
            <div className="relative overflow-hidden h-120 bg-[hsl(220_12%_5%)]">
                <div className="relative">
                    <div className="px-5 pt-5 pb-4">
                        <div className="mb-4 flex items-center justify-between">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    animate={{ opacity: 1, x: 0 }}
                                    className="flex items-center gap-2"
                                    exit={{ opacity: 0, x: -5 }}
                                    initial={{ opacity: 0, x: 5 }}
                                    key={demo.pkg}
                                    transition={{ duration: 0.15 }}
                                >
                                    <span className="font-mono text-xs font-medium text-white/40">{demo.pkg}</span>
                                </motion.div>
                            </AnimatePresence>
                        </div>

                        <AnimatePresence mode="wait">
                            <motion.div
                                animate={{ opacity: 1 }}
                                className="font-mono text-[13px] leading-[1.8]"
                                exit={{ opacity: 0 }}
                                initial={{ opacity: 0 }}
                                key={activeIndex}
                                transition={{ duration: 0.12 }}
                            >
                                {demo.code.map((line, index) => (
                                    <div className="flex" key={index}>
                                        <span className="mr-4 w-4 shrink-0 text-right text-white/[0.08] select-none">{index + 1}</span>
                                        <CodeLine content={line} />
                                    </div>
                                ))}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    <div className="mx-3 mb-3 overflow-hidden bg-black/30">
                        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                            <Play className="h-2.5 w-2.5 fill-emerald-400/60 text-emerald-400/60" />
                            <span className="font-mono text-[10px] font-medium tracking-wider text-emerald-400/40 uppercase">Output</span>
                        </div>

                        <div className="min-h-[90px] px-4 pt-1 pb-3 font-mono text-[13px] leading-relaxed">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    initial={{ opacity: 0 }}
                                    key={activeIndex}
                                    transition={{ duration: 0.1 }}
                                >
                                    {demo.output.map((line, index) => {
                                        if (index >= visibleLines) {
                                            return null;
                                        }

                                        return (
                                            <div key={`${activeIndex}-${index}`}>
                                                <span className={line.color ?? "text-white/30"}>{line.text || "\u00A0"}</span>
                                            </div>
                                        );
                                    })}
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-4 flex justify-center">
                <div className="inline-flex items-center gap-1 border border-white/20 bg-white/10 px-1.5 py-1 backdrop-blur-xl">
                    {packageDemos.map((d, index) => (
                        <button
                            className={cn(
                                "px-4 py-1.5 font-mono text-xs transition-all duration-200 cursor-pointer",
                                index === activeIndex ? "bg-white/10 text-white/70" : "text-white hover:text-white/80",
                            )}
                            key={d.label}
                            onClick={() => {
                                setActiveIndex(index);
                            }}
                            type="button"
                        >
                            {d.label}
                        </button>
                    ))}
                </div>
            </div>
        </motion.div>
    );
};

const packageTicker = [
    { name: "server" },
    { name: "client" },
    { name: "react" },
    { name: "vue" },
    { name: "solid" },
    { name: "svelte" },
    { name: "do" },
    { name: "runtime" },
    { name: "values" },
    { name: "codegen" },
    { name: "vite" },
    { name: "auth" },
    { name: "storage" },
    { name: "scheduler" },
];

const PackageTicker: FC = () => {
    const doubled = [...packageTicker, ...packageTicker];

    return (
        <motion.div
            animate={{ opacity: 1 }}
            className="absolute inset-x-0 bottom-0 z-20 overflow-hidden border-y border-white/[0.04] bg-coal/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            transition={{ delay: 2.5, duration: 1 }}
        >
            <div className="flex animate-scroll-left whitespace-nowrap py-3">
                {doubled.map((pkg, index) => (
                    <span
                        className="mx-4 inline-flex items-center gap-2 font-mono text-xs text-white/20 transition-colors hover:text-white/40"
                        key={`${pkg.name}-${index}`}
                    >
                        <Package className="h-3 w-3" />
                        @lunora/
                        {pkg.name}
                    </span>
                ))}
            </div>
        </motion.div>
    );
};

const MainHero: FC = () => (
    <div className="relative bg-background">
        <Section
            classes={{
                childrenWrapper: "!grid-cols-1 lg:!grid-cols-2 items-center gap-12 md:gap-0",
                root: "h-screen",
            }}
            gridLength={2}
            mode="dark"
        >
            <div>
                <p className="sr-only">
                    Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer experience. Define
                    a schema and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live subscriptions,
                    optimistic updates, and an offline queue — types sync from server to client automatically via codegen.
                </p>

                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-8 flex items-center gap-5"
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ delay: 0.3, duration: 0.5 }}
                >
                    {[
                        { label: "Runtime", value: "Edge" },
                        { label: "License", value: "MIT" },
                        { label: "TypeScript", value: "100%" },
                    ].map((stat, index) => (
                        <div className="flex items-center gap-2" key={stat.label}>
                            {index > 0 && <span className="mr-3 h-3 w-px bg-white/[0.08]" />}
                            <span className="font-mono text-sm font-semibold text-white/70">{stat.value}</span>
                            <span className="font-mono text-xs text-white/25">{stat.label}</span>
                        </div>
                    ))}
                </motion.div>

                <motion.h1
                    animate={{ opacity: 1, y: 0 }}
                    className="text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl md:text-6xl lg:text-[4rem]"
                    initial={{ opacity: 0, y: 20 }}
                    transition={{ delay: 0.5, duration: 0.7, ease: "easeOut" }}
                >
                    <span className="flex items-baseline gap-3">
                        <WordRotate
                            className="inline-block bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent"
                            duration={2800}
                            framerProps={{
                                animate: { opacity: 1, y: 0 },
                                exit: { opacity: 0, y: -20 },
                                initial: { opacity: 0, y: 20 },
                                transition: { duration: 0.3, ease: "easeOut" },
                            }}
                            words={["Query.", "Mutate.", "Subscribe.", "Sync.", "Ship."]}
                        />
                    </span>
                    <span className="mt-1 block text-white/90">Real-time backend,</span>
                    <span className="block text-white/90">end-to-end typed.</span>
                </motion.h1>

                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8 flex flex-wrap gap-2"
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ delay: 0.9, duration: 0.5, ease: "easeOut" }}
                >
                    {["Queries", "Mutations", "Subscriptions", "Optimistic", "Offline", "Durable Objects", "Sharding", "Codegen"].map((cat, index) => (
                        <motion.span
                            animate={{ opacity: 1, scale: 1 }}
                            className="border border-white/[0.06] bg-white/[0.02] px-3 py-1 font-mono text-xs text-white/30 transition-colors hover:border-white/[0.12] hover:text-white/50"
                            initial={{ opacity: 0, scale: 0.9 }}
                            key={cat}
                            transition={{ delay: 1 + index * 0.05, duration: 0.3 }}
                        >
                            {cat}
                        </motion.span>
                    ))}
                </motion.div>

                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-10 flex flex-wrap items-center gap-5"
                    initial={{ opacity: 0, y: 15 }}
                    transition={{ delay: 1.2, duration: 0.6, ease: "easeOut" }}
                >
                    <Link
                        className="group relative inline-flex items-center gap-3 overflow-hidden border border-white/[0.15] bg-white px-7 py-3.5 text-sm font-semibold text-coal transition-all duration-300 hover:bg-white/90"
                        to="/docs/$"
                    >
                        <span>Get started</span>
                        <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                            style={{
                                background: "linear-gradient(135deg, transparent 40%, hsla(210,100%,45%,0.08), hsla(282,44%,47%,0.08))",
                            }}
                        />
                    </Link>
                    <Link
                        className="group inline-flex items-center gap-2 border border-white/[0.08] bg-white/[0.03] px-6 py-3.5 text-sm font-medium text-white/50 backdrop-blur-sm transition-all duration-300 hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white/80"
                        to="/packages"
                    >
                        <span>Browse packages</span>
                        <ChevronRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
                    </Link>
                </motion.div>
            </div>

            <PackageShowcase />
        </Section>
        <PackageTicker />
    </div>
);

export default MainHero;
