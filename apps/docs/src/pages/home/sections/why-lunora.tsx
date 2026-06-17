import { ChartNoAxesCombined, Cog, Lock, Puzzle, Shield, Timer } from "lucide-react";

import AuroraMesh from "@/components/sections/aurora-mesh";
import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";
import { BentoGrid, BentoSpotlightCard } from "@/components/ui/bento";

// Aurora reveal pairs — cyan / violet / rose (see DESIGN.md §2)
const AURORA_CYAN: [number, number, number][] = [
    [41, 212, 223],
    [125, 232, 240],
];
const AURORA_VIOLET: [number, number, number][] = [
    [146, 119, 233],
    [182, 162, 244],
];
const AURORA_ROSE: [number, number, number][] = [
    [236, 92, 164],
    [244, 146, 193],
];

const features = [
    {
        className: "lg:row-start-2 lg:row-end-2 lg:col-start-1 lg:col-end-3 border-r border-t border-white/[0.06]",
        description:
            "Define a schema, write query and mutation functions, and the client gets typed data with live subscriptions. No REST boilerplate, no GraphQL schema duplication, no manual cache wiring — ship features instead of plumbing.",
        Icon: Timer,
        name: "Ship Faster",
        revealColors: AURORA_CYAN,
    },
    {
        className: "lg:row-start-1 lg:row-end-2 lg:col-start-2 lg:col-end-3",
        description:
            "Types flow from your server functions to the client through codegen. Rename a field on the server and the client stops compiling — every query, mutation, and subscription is checked end-to-end at build time.",
        Icon: Lock,
        name: "End-to-End Typed",
        revealColors: AURORA_CYAN,
    },
    {
        className: "lg:col-start-1 lg:row-start-1 lg:col-end-1 lg:row-end-1",
        description:
            "Queries are subscriptions. When a mutation changes the data a query reads, every connected client re-renders automatically over WebSocket — no polling, no manual invalidation, just live data.",
        Icon: Puzzle,
        name: "Real-Time by Default",
        revealColors: AURORA_ROSE,
    },
    {
        className: "lg:col-start-3 lg:row-start-1 border-r border-b border-white/[0.06]",
        description:
            "State lives in a SQLite-backed Durable Object with optimistic concurrency control, running close to your users at the edge. One Durable Object per app by default — predictable, consistent, and easy to reason about.",
        Icon: Shield,
        name: "Durable & Consistent",
        revealColors: AURORA_VIOLET,
    },
    {
        className: "lg:row-start-2 lg:row-end-2 lg:col-start-3 lg:col-end-3",
        description:
            "Mutations apply instantly on the client and reconcile with the server's authoritative result. Lose connection and they queue durably, then flush in order when you reconnect — your UI stays responsive offline.",
        Icon: ChartNoAxesCombined,
        name: "Optimistic & Offline",
        revealColors: AURORA_VIOLET,
    },
    {
        className: "lg:row-start-2 lg:col-start-4",
        description:
            "A Vite plugin powers codegen, type sync, and the dev server, so your workflow feels instant. Start with a single Durable Object, then opt into .shardBy() partitioning or .global() replication as you scale.",
        Icon: Cog,
        name: "Vite-First DX",
        revealColors: AURORA_CYAN,
    },
];

const WhyLunora = () => (
    <div className="bg-background relative overflow-hidden" data-theme="dark">
        <SectionDivider />
        <AuroraMesh placement="top-left" />
        <Section classes={{ root: "relative z-10" }} gridLength={0} mode="dark">
            <div className="col-span-full mb-16">
                <SectionHeader
                    eyebrow="Why Lunora"
                    subhead="Define your schema, write your functions, and let the framework handle sync, subscriptions, and scale — on Cloudflare Workers and Durable Objects."
                    title="Type-safe. Real-time. Edge-native."
                />
            </div>
            <div className="col-span-full">
                <BentoGrid className="border-y border-white/[0.06]">
                    {features.map((feature) => (
                        <BentoSpotlightCard key={feature.name} {...feature} className={feature.className} />
                    ))}
                </BentoGrid>
            </div>
        </Section>
    </div>
);

export default WhyLunora;
