import { ChartNoAxesCombined, Cog, Lock, Puzzle, Shield, Timer } from "lucide-react";

import Section from "@/components/sections/section";
import SectionSeparator from "@/components/sections/section-separator";
import SectionTitle from "@/components/sections/section-title";
import { BentoGrid, BentoSpotlightCard } from "@/components/ui/bento";

const features = [
    {
        className: "lg:row-start-2 lg:row-end-2 lg:col-start-1 lg:col-end-3 border-r border-t border-white/[0.06]",
        description:
            "Define a schema, write query and mutation functions, and the client gets typed data with live subscriptions. No REST boilerplate, no GraphQL schema duplication, no manual cache wiring — ship features instead of plumbing.",
        Icon: Timer,
        name: "Ship Faster",
        revealColors: [
            [0, 122, 204],
            [56, 189, 248],
        ],
    },
    {
        className: "lg:row-start-1 lg:row-end-2 lg:col-start-2 lg:col-end-3",
        description:
            "Types flow from your server functions to the client through codegen. Rename a field on the server and the client stops compiling — every query, mutation, and subscription is checked end-to-end at build time.",
        Icon: Lock,
        name: "End-to-End Typed",
        revealColors: [
            [0, 122, 204],
            [56, 189, 248],
        ],
    },
    {
        className: "lg:col-start-1 lg:row-start-1 lg:col-end-1 lg:row-end-1",
        description:
            "Queries are subscriptions. When a mutation changes the data a query reads, every connected client re-renders automatically over WebSocket — no polling, no manual invalidation, just live data.",
        Icon: Puzzle,
        name: "Real-Time by Default",
        revealColors: [
            [204, 50, 50],
            [248, 113, 113],
        ],
    },
    {
        className: "lg:col-start-3 lg:row-start-1 border-r border-b border-white/[0.06]",
        description:
            "State lives in a SQLite-backed Durable Object with optimistic concurrency control, running close to your users at the edge. One Durable Object per app by default — predictable, consistent, and easy to reason about.",
        Icon: Shield,
        name: "Durable & Consistent",
        revealColors: [
            [128, 71, 153],
            [168, 85, 247],
        ],
    },
    {
        className: "lg:row-start-2 lg:row-end-2 lg:col-start-3 lg:col-end-3",
        description:
            "Mutations apply instantly on the client and reconcile with the server's authoritative result. Lose connection and they queue durably, then flush in order when you reconnect — your UI stays responsive offline.",
        Icon: ChartNoAxesCombined,
        name: "Optimistic & Offline",
        revealColors: [
            [128, 71, 153],
            [168, 85, 247],
        ],
    },
    {
        className: "lg:row-start-2 lg:col-start-4",
        description:
            "A Vite plugin powers codegen, type sync, and the dev server, so your workflow feels instant. Start with a single Durable Object, then opt into .shardBy() partitioning or .global() replication as you scale.",
        Icon: Cog,
        name: "Vite-First DX",
        revealColors: [
            [0, 122, 204],
            [56, 189, 248],
        ],
    },
];

const WhyLunora = () => (
    <div className="bg-background relative">
        <Section
            classes={{
                lineGrid: "border-dotted border-white/[0.06]",
                pattern: "inset-y-10",
            }}
            mode="dark"
            patternColor="sky-sapphire"
        >
            <div className="col-span-2 mb-16">
                <SectionTitle
                    description={
                        <span className="flex flex-col gap-4">
                            <span className="text-white/55">Lunora gives you a type-safe, real-time backend on Cloudflare Workers and Durable Objects.</span>
                            <span className="text-white/35">
                                Define your schema, write your functions, and let the framework handle sync, subscriptions, and scale.
                            </span>
                        </span>
                    }
                    mode="dark"
                    prefix="Why Lunora?"
                    title="Type-Safe. Real-Time. Edge-Native."
                />
            </div>
            <div className="col-span-4">
                <BentoGrid className="border-y border-white/[0.06]">
                    {features.map((feature) => (
                        <BentoSpotlightCard key={feature.name} {...feature} className={feature.className} />
                    ))}
                </BentoGrid>
            </div>
        </Section>
        <SectionSeparator bgColor="bg-background" fillColor="fill-background" position="bottom" />
    </div>
);

export default WhyLunora;
