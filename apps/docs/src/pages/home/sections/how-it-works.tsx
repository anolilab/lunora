"use client";

import { Check } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { FC, ReactNode } from "react";
import { useEffect, useState } from "react";

import CodeView from "@/components/sections/code-view";
import { cn } from "@/lib/utils";

/**
 * Axon-style "how it works" stepper: an auto-advancing accordion on the left
 * (active step expands with a filling progress bar) driving a per-step visual
 * on the right. Click a step to pin it; respects reduced motion.
 */

const SCHEMA_CODE = [
    "import { defineSchema, defineTable, v } from 'lunorash/server';",
    "",
    "export default defineSchema({",
    "  todos: defineTable({",
    "    text: v.string(),",
    "    done: v.boolean(),",
    "  }),",
    "});",
];

const FUNCTION_CODE = [
    "export const list = query.query(",
    "  async ({ ctx }) => ctx.db.query('todos').collect(),",
    ");",
    "",
    "export const add = mutation",
    "  .input({ text: v.string() })",
    "  .mutation(async ({ ctx, args }) =>",
    "    ctx.db.insert('todos', { ...args, done: false }),",
    "  );",
];

const ShipPanel: FC = () => (
    <div className="flex size-full flex-col overflow-hidden border border-white/[0.08] bg-[hsl(240_22%_4%)] font-mono">
        <div className="flex h-10 items-center justify-between border-b border-white/[0.07] px-4">
            <span className="flex items-center gap-2 text-xs text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60" />
                lunora · deployed
            </span>
            <span className="text-[10px] text-white/40">my-app.lunora.app</span>
        </div>
        <div className="flex flex-col py-2">
            {["codegen — types in sync", "advisors — 0 issues", "deployed to your Cloudflare account"].map((label) => (
                <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5 last:border-b-0" key={label}>
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-emerald-400/50 bg-emerald-400/10">
                        <Check className="size-2.5 text-emerald-400" />
                    </span>
                    <span className="text-xs text-white/55">{label}</span>
                </div>
            ))}
        </div>
        <div className="m-4 mt-auto border border-emerald-400/15 bg-white/[0.02] p-3.5">
            <p className="text-xs text-white/70">Live, globally · syncing to all clients</p>
            <div className="mt-2.5 flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-0.5">
                    <span className="size-1 rounded-full bg-emerald-400" />
                    <span className="text-[10px] text-emerald-400">live</span>
                </span>
                <span className="text-[10px] text-white/40">edge · 300+ locations</span>
            </div>
        </div>
    </div>
);

interface Step {
    desc: string;
    index: string;
    panel: ReactNode;
    title: string;
}

const STEPS: Step[] = [
    {
        desc: "Declare your tables once. Lunora generates the typed data model your server and client share.",
        index: "01",
        panel: <CodeView className="size-full" filename="lunora/schema.ts" lines={SCHEMA_CODE} numbers />,
        title: "Define your schema",
    },
    {
        desc: "Write query, mutation, and action functions in pure TypeScript — typed end to end, no glue code.",
        index: "02",
        panel: <CodeView className="size-full" filename="lunora/todos.ts" lines={FUNCTION_CODE} numbers />,
        title: "Write functions",
    },
    {
        desc: "Deploy to your own Cloudflare account. Codegen runs, advisors pass, and clients sync live — globally.",
        index: "03",
        panel: <ShipPanel />,
        title: "Ship live",
    },
];

const STEP_MS = 100;
const STEP_INCREMENT = 2;

const HowItWorks: FC = () => {
    const reduceMotion = useReducedMotion();
    const [active, setActive] = useState(0);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (reduceMotion) {
            return undefined;
        }

        // Reaching the end advances to the next step and resets the bar — done in the
        // timer tick (the source of the change) rather than in a reactive effect on
        // `progress`, which would chain state updates.
        const advance = (previous: number): number => {
            const next = previous + STEP_INCREMENT;

            if (next >= 100) {
                setActive((current) => (current + 1) % STEPS.length);

                return 0;
            }

            return next;
        };

        const tick = (): void => {
            setProgress(advance);
        };

        const id = setInterval(tick, STEP_MS);

        return () => {
            clearInterval(id);
        };
    }, [reduceMotion]);

    const select = (index: number) => {
        setActive(index);
        setProgress(0);
    };

    return (
        <div className="grid grid-cols-1 border border-white/[0.08] lg:grid-cols-2 lg:border-x-0">
            {/* left — accordion */}
            <div className="flex flex-col lg:border-r lg:border-white/[0.08]">
                {STEPS.map((step, index) => {
                    const isActive = index === active;

                    return (
                        <button
                            aria-expanded={isActive}
                            className={cn(
                                "relative border-b border-white/[0.08] px-8 py-7 text-left transition-colors last:border-b-0",
                                isActive ? "bg-white/[0.02]" : "hover:bg-white/[0.015]",
                            )}
                            key={step.index}
                            onClick={() => {
                                select(index);
                            }}
                            type="button"
                        >
                            <span className="font-mono text-xs text-white/35">Step {step.index}</span>
                            <h3 className={cn("mt-2 text-2xl font-medium tracking-tight transition-colors", isActive ? "text-white" : "text-white/55")}>
                                {step.title}
                            </h3>
                            <div
                                className={cn("grid transition-all duration-300", isActive ? "mt-3 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
                            >
                                <p className="overflow-hidden text-sm leading-relaxed text-white/50">{step.desc}</p>
                            </div>
                            {isActive && !reduceMotion ? (
                                <div className="mt-5 h-px w-full bg-white/[0.08]">
                                    <div
                                        className="h-px bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy"
                                        style={{ width: `${progress.toFixed(1)}%` }}
                                    />
                                </div>
                            ) : null}
                        </button>
                    );
                })}
            </div>

            {/* right — active panel */}
            <div className="relative min-h-[360px] bg-[hsl(240_20%_4.5%)] p-6 lg:min-h-[440px]">
                <div className="size-full" key={active}>
                    {STEPS[active].panel}
                </div>
            </div>
        </div>
    );
};

export default HowItWorks;
