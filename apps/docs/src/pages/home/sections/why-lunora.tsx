"use client";

import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useState } from "react";

import AuroraMesh from "@/components/sections/aurora-mesh";
import Reveal from "@/components/sections/reveal";
import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";
import { cn } from "@/lib/utils";

const KEYWORD = /^(import|from|const|await|export|async|function|return|default)$/;
const WHITESPACE = /^\s+$/;
const STRING_START = /^["'`]/;
const PUNCTUATION = /^[{}()[\];,.=>:]+$/;

interface Feature {
    code: string[];
    description: string;
    file: string;
    title: string;
}

const features: Feature[] = [
    {
        code: [
            'import { useQuery } from "@lunora/react";',
            'import { api } from "./_generated/api";',
            "",
            "const messages = useQuery(api.messages.list);",
            "//        ^?  Message[] — typed end-to-end",
            "messages.map((m) => m.body);",
        ],
        description:
            "Types flow from your server functions to the client through codegen. Rename a field and the client stops compiling — checked at build time.",
        file: "Chat.tsx",
        title: "End-to-end typed",
    },
    {
        code: [
            "export const list = query.query(",
            "  async ({ ctx }) =>",
            '    ctx.db.query("messages").collect(),',
            ");",
            "// every subscribed client re-renders",
            "// the moment a mutation writes.",
        ],
        description:
            "Queries are subscriptions. When a mutation changes the data a query reads, every connected client re-renders over WebSocket — no polling.",
        file: "messages.ts",
        title: "Real-time by default",
    },
    {
        code: [
            "export default defineSchema({",
            "  messages: defineTable({",
            "    body: v.string(),",
            '  }).shardBy("roomId"),',
            "});",
            "// SQLite in a Durable Object, at the edge",
        ],
        description:
            "State lives in a SQLite-backed Durable Object with optimistic concurrency, running close to your users. Opt into sharding or global replication as you scale.",
        file: "schema.ts",
        title: "Edge-native",
    },
    {
        code: [
            "const like = useMutation(api.messages.like)",
            "  .withOptimisticUpdate((store, { id }) =>",
            "    store.patch(id, { liked: true }),",
            "  );",
            "// applies instantly · queues when offline",
            "// flushes in order on reconnect",
        ],
        description:
            "Mutations apply instantly on the client and reconcile with the server. Lose connection and they queue durably, then flush in order when you reconnect.",
        file: "useLike.ts",
        title: "Optimistic & offline",
    },
    {
        code: ["$ lunora dev", "● codegen   _generated/api.ts", "● types     server → client", "● ready     in 312ms", "", "# edit schema.ts → types resync"],
        description:
            "A Vite plugin powers codegen, type sync, and the dev server, so your workflow feels instant. Edit your schema and the typed API regenerates as you save.",
        file: "terminal",
        title: "Vite-first DX",
    },
];

const CodeLines: FC<{ lines: string[] }> = ({ lines }) => (
    <pre className="overflow-x-auto font-mono text-[13px] leading-[1.85]">
        {lines.map((line, index) => {
            const trimmed = line.trimStart();

            if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
                return (
                    <div className="text-white/30" key={index}>
                        {line || " "}
                    </div>
                );
            }

            if (trimmed.startsWith("●") || trimmed.startsWith("$")) {
                return (
                    <div className="text-emerald-400/70" key={index}>
                        {line}
                    </div>
                );
            }

            return (
                <div key={index}>
                    {line.split(/(\s+)/).map((segment, segmentIndex) => {
                        if (WHITESPACE.test(segment) || !segment) {
                            return <span key={segmentIndex}>{segment || " "}</span>;
                        }

                        let colorClass = "text-white/65";

                        if (KEYWORD.test(segment)) colorClass = "text-crimson-energy/70";
                        else if (STRING_START.test(segment)) colorClass = "text-sky-sapphire/75";
                        else if (PUNCTUATION.test(segment)) colorClass = "text-white/25";

                        return (
                            <span className={colorClass} key={segmentIndex}>
                                {segment}
                            </span>
                        );
                    })}
                </div>
            );
        })}
    </pre>
);

const WhyLunora = () => {
    const [active, setActive] = useState(0);
    const feature = features[active];

    return (
        <div className="bg-background relative overflow-hidden" data-theme="dark">
            <SectionDivider />
            <AuroraMesh placement="top-left" />
            <Section classes={{ root: "relative z-10" }} gridLength={0} mode="dark">
                <div className="col-span-full">
                    <SectionHeader
                        eyebrow="Why Lunora"
                        subhead="Define your schema, write your functions, and let the framework handle sync, subscriptions, and scale — on Cloudflare Workers and Durable Objects."
                        title="Type-safe. Real-time. Edge-native."
                    />
                </div>

                <Reveal className="col-span-full mt-14 grid gap-2.5 lg:grid-cols-[0.9fr_1.1fr]" delay={0.1}>
                    {/* feature list */}
                    <div aria-label="Lunora capabilities" className="flex flex-col border-b border-white/[0.08]" role="tablist">
                        {features.map((item, index) => {
                            const isActive = index === active;

                            return (
                                <button
                                    aria-selected={isActive}
                                    className={cn(
                                        "relative border-t border-white/[0.08] py-5 pr-4 pl-5 text-left transition-colors outline-none focus-visible:bg-white/[0.04]",
                                        isActive ? "bg-white/[0.03]" : "hover:bg-white/[0.015]",
                                    )}
                                    key={item.title}
                                    onClick={() => {
                                        setActive(index);
                                    }}
                                    onFocus={() => {
                                        setActive(index);
                                    }}
                                    onMouseEnter={() => {
                                        setActive(index);
                                    }}
                                    role="tab"
                                    type="button"
                                >
                                    {isActive && (
                                        <motion.span
                                            className="absolute top-0 left-0 h-full w-0.5 bg-gradient-to-b from-sky-sapphire via-royal-amethyst to-crimson-energy"
                                            layoutId="why-active"
                                            transition={{ damping: 30, stiffness: 420, type: "spring" }}
                                        />
                                    )}
                                    <span className={cn("text-lg font-medium tracking-tight transition-colors", isActive ? "text-white" : "text-white/55")}>
                                        {item.title}
                                    </span>
                                    <AnimatePresence initial={false}>
                                        {isActive && (
                                            <motion.p
                                                animate={{ height: "auto", opacity: 1 }}
                                                className="overflow-hidden pt-2 text-sm leading-snug text-white/50"
                                                exit={{ height: 0, opacity: 0 }}
                                                initial={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2, ease: "easeOut" }}
                                            >
                                                {item.description}
                                            </motion.p>
                                        )}
                                    </AnimatePresence>
                                </button>
                            );
                        })}
                    </div>

                    {/* live code panel */}
                    <div
                        aria-label={`${feature.title} example`}
                        className="flex min-h-[20rem] flex-col overflow-hidden border border-white/10 bg-[hsl(240_16%_5%)]"
                        role="tabpanel"
                    >
                        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.08] px-3">
                            <span className="flex gap-1.5">
                                <span className="size-2.5 rounded-full bg-white/[0.08]" />
                                <span className="size-2.5 rounded-full bg-white/[0.08]" />
                                <span className="size-2.5 rounded-full bg-white/[0.08]" />
                            </span>
                            <span className="ml-1 font-mono text-[11px] text-white/40">{feature.file}</span>
                        </div>
                        <div className="grow p-5">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    initial={{ opacity: 0 }}
                                    key={active}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                >
                                    <CodeLines lines={feature.code} />
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </div>
                </Reveal>
            </Section>
        </div>
    );
};

export default WhyLunora;
