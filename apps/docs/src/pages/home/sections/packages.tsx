import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";
import HighlightLink from "@/components/ui/highlight-link";
import { cn } from "@/lib/utils";

const FeatureCard = ({ accentColor, children, className, title }: { accentColor: string; children: React.ReactNode; className?: string; title: string }) => (
    <div className={cn("group/feature relative flex w-full flex-col gap-4 px-8 pt-8 pb-10 transition-all duration-300 hover:bg-white/[0.02]", className)}>
        <div className={`absolute top-0 left-8 right-8 h-px ${accentColor} opacity-0 transition-opacity duration-500 group-hover/feature:opacity-100`} />
        <h3 className="font-mono text-sm font-semibold tracking-wide text-white/80 transition-colors duration-300 group-hover/feature:text-white">{title}</h3>
        <span className="text-wrap-balance text-sm leading-relaxed text-white/40 transition-colors duration-300 group-hover/feature:text-white/60">
            {children}
        </span>
    </div>
);

interface BuildStep {
    color?: string;
    delay: number;
    text: string;
    type: "cmd" | "info" | "entry" | "chunk" | "total" | "done";
}

const BUILD_SEQUENCES: BuildStep[][] = [
    [
        { delay: 0, text: "$ lunora dev", type: "cmd" },
        { delay: 500, text: "INFO  [lunora] Starting Vite dev server with codegen", type: "info" },
        { delay: 200, text: "INFO  [lunora] Watching lunora/schema.ts for changes", type: "info" },
        { delay: 300, text: "INFO  [lunora] Detected tables: messages, users", type: "info" },
        { delay: 200, text: "INFO  [lunora] Generating _generated/{api,server,dataModel}.ts", type: "info" },
        { delay: 400, text: "INFO  [lunora] Booting Durable Object runtime", type: "info" },
        { delay: 600, text: "SUCCESS  Types synced server → client", type: "entry" },
        { delay: 200, text: "Endpoints:", type: "info" },
        { delay: 250, text: "  ➜  Local:    http://localhost:5173/", type: "chunk" },
        { delay: 200, text: "  ➜  Worker:   ws://localhost:8787/", type: "chunk" },
        { delay: 150, text: "  ➜  Studio:   http://localhost:5173/_studio", type: "chunk" },
        { delay: 300, text: "Σ 4 functions · 2 tables · live subscriptions", type: "total" },
        { delay: 250, text: "⚡️ Ready in 0.312 seconds", type: "done" },
    ],
    [
        { delay: 0, text: "$ lunora deploy", type: "cmd" },
        { delay: 500, text: "INFO  [lunora] Running codegen before deploy", type: "info" },
        { delay: 200, text: "INFO  [lunora] Reconciling wrangler.jsonc bindings", type: "info" },
        { delay: 300, text: "INFO  [lunora] Durable Object: ShardDO [sqlite]", type: "info" },
        { delay: 150, text: "INFO  [lunora] Uploading Worker to Cloudflare", type: "info" },
        { delay: 200, text: "INFO  [lunora] Applying schema migrations", type: "info" },
        { delay: 400, text: "INFO  [lunora] Publishing routes", type: "info" },
        { delay: 600, text: "SUCCESS  Deployed to the edge", type: "entry" },
        { delay: 200, text: "Bindings:", type: "info" },
        { delay: 250, text: "  └─ DURABLE_OBJECT  ShardDO", type: "chunk" },
        { delay: 100, text: "  └─ D1             global tables", type: "chunk" },
        { delay: 100, text: "  └─ WEBSOCKET      hibernated subscriptions", type: "chunk" },
        { delay: 300, text: "Σ Live at https://my-app.workers.dev", type: "total" },
        { delay: 250, text: "⚡️ Deploy run in 2.104 seconds", type: "done" },
    ],
];

const getStepColor = (step: BuildStep): string => {
    if (step.color) {
        return step.color;
    }

    switch (step.type) {
        case "chunk": {
            return "text-white/40";
        }
        case "cmd": {
            return "text-white/80";
        }
        case "done": {
            return "text-sky-sapphire";
        }
        case "entry": {
            return "text-emerald-400";
        }
        case "info": {
            return "text-white/30";
        }
        case "total": {
            return "text-white/50";
        }
        default: {
            return "text-white/40";
        }
    }
};

const ServerTerminal = () => {
    const [seqIndex, setSeqIndex] = useState(0);
    const [visibleSteps, setVisibleSteps] = useState(0);

    const sequence = BUILD_SEQUENCES[seqIndex % BUILD_SEQUENCES.length];

    useEffect(() => {
        if (visibleSteps >= sequence.length) {
            // Pause at the end, then advance to the next sequence
            const timer = setTimeout(() => {
                setSeqIndex((s) => s + 1);
                setVisibleSteps(0);
            }, 2500);

            return () => {
                clearTimeout(timer);
            };
        }

        const nextStep = sequence[visibleSteps];

        if (!nextStep) {
            return;
        }

        const timer = setTimeout(() => {
            setVisibleSteps((v) => v + 1);
        }, nextStep.delay);

        return () => {
            clearTimeout(timer);
        };
    }, [visibleSteps, sequence, seqIndex]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2.5">
                <div className="flex gap-1.5">
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                </div>
                <span className="font-mono text-[10px] tracking-wider text-white/20 uppercase">lunora — dev</span>
            </div>

            <div className="flex-1 overflow-hidden px-4 py-3 font-mono text-xs leading-6">
                <AnimatePresence mode="popLayout">
                    {sequence.slice(0, visibleSteps).map((step, i) => (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className={cn("whitespace-pre", getStepColor(step))}
                            exit={{ opacity: 0 }}
                            initial={{ opacity: 0, y: 4 }}
                            key={`${seqIndex}-${i}`}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                            {step.type === "cmd" && <span className="text-sky-sapphire/60">$ </span>}
                            {step.type === "cmd" ? (
                                step.text.slice(2)
                            ) : step.text.startsWith("INFO") ? (
                                <>
                                    <span className="text-sky-sapphire/60">INFO</span>
                                    <span>{step.text.slice(4)}</span>
                                </>
                            ) : step.text.startsWith("SUCCESS") ? (
                                <>
                                    <span className="text-emerald-400">SUCCESS</span>
                                    <span className="text-white/50">{step.text.slice(7)}</span>
                                </>
                            ) : (
                                step.text
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {visibleSteps < sequence.length && (
                    <motion.span
                        animate={{ opacity: [1, 0] }}
                        className="inline-block h-3.5 w-1.5 translate-y-0.5 bg-sky-sapphire/60"
                        transition={{ duration: 0.8, repeat: Infinity, repeatType: "reverse" }}
                    />
                )}
            </div>
        </div>
    );
};

const ServerSection = () => (
    <Section classes={{ root: "pt-12" }} gridLength={0} mode="dark">
        <div className="hidden lg:col-span-1 lg:block" />
        <div className="col-span-4 -ml-px flex flex-col xl:col-span-3 bg-background">
            <div className="relative overflow-hidden border-b border-white/[0.08] bg-[hsl(240_16%_5%)]">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-sky-sapphire/60 to-transparent" />
                <div className="grid grid-cols-2">
                    <div className="min-h-120 bg-[hsl(240_16%_4%)]">
                        <ServerTerminal />
                    </div>

                    <div className="z-10 flex w-full flex-col gap-4 px-8 pt-8 pb-14 border-l border-white/[0.08]">
                        <div className="flex items-center gap-3">
                            <span className="inline-block bg-sky-sapphire/20 px-3 py-1 font-mono text-xs font-medium text-sky-sapphire">Server</span>
                        </div>
                        <h3 className="text-2xl font-bold tracking-tight text-white">@lunora/server</h3>
                        <span className="text-sm leading-relaxed text-white/60">
                            Define a schema and write typed query, mutation, and action functions that run on Cloudflare Workers and Durable Objects. A
                            Vite-first dev server boots the runtime and regenerates types as you edit.
                        </span>
                        <span className="text-sm leading-relaxed text-white/40">
                            One Durable Object per app by default — opt into `.shardBy(key)` sharding or `.global()` replication when you need it.
                        </span>
                        <div className="mt-auto pt-6">
                            <Link
                                className="inline-flex items-center gap-2 bg-sky-sapphire/20 px-3 py-1.5 text-sm font-medium text-sky-sapphire transition-colors hover:bg-sky-sapphire/30 hover:text-white"
                                params={{ slug: "server" }}
                                to="/packages/$slug"
                            >
                                Explore @lunora/server
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-2 border-x border-white/[0.08]">
                <FeatureCard accentColor="bg-sky-sapphire/40" title="Schema-first">
                    Declare your tables and validators once with <code className="text-sky-sapphire/80">defineSchema</code> and{" "}
                    <code className="text-sky-sapphire/80">defineTable</code>. Codegen turns that schema into a fully typed data model shared between server and
                    client.
                </FeatureCard>
                <FeatureCard accentColor="bg-sky-sapphire/40" className="border-l border-white/[0.08]" title="Typed functions">
                    Write <code className="text-sky-sapphire/80">query</code>, <code className="text-sky-sapphire/80">mutation</code>, and{" "}
                    <code className="text-sky-sapphire/80">action</code> handlers. Arguments and return types are inferred end-to-end — no manual API contracts.
                </FeatureCard>
            </div>
            <div className="grid grid-cols-2 border-x border-b border-white/[0.08]">
                <FeatureCard accentColor="bg-sky-sapphire/40" className="border-t border-white/[0.08]" title="Durable state">
                    State lives in a SQLite-backed Durable Object with optimistic concurrency control. Reads and writes are consistent, transactional, and close
                    to your users at the edge.
                </FeatureCard>
                <FeatureCard accentColor="bg-sky-sapphire/40" className="border-t border-l border-white/[0.08]" title="Scales on demand">
                    Start with a single Durable Object, then partition by user, tenant, or room with <code className="text-sky-sapphire/80">.shardBy()</code>,
                    or replicate globally with <code className="text-sky-sapphire/80">.global()</code>.
                </FeatureCard>
            </div>
        </div>
    </Section>
);

const LOG_LINES = [
    { color: "text-sky-sapphire", level: "subscribe", prefix: "  ◉", text: "useQuery(api.messages.list)" },
    { color: "text-emerald-400", level: "insert", prefix: "  ●", text: "Ada: Hello from the edge" },
    { color: "text-amber-400", level: "optimistic", prefix: "  …", text: 'send({ body: "Shipping it" })' },
    { color: "text-emerald-400", level: "confirmed", prefix: "  ✔", text: "mutation acked by Durable Object" },
    { color: "text-violet-400", level: "patch", prefix: "  ◉", text: "messages[2].liked = true" },
    { color: "text-crimson-energy", level: "offline", prefix: "  ▲", text: "connection lost → queued" },
    { color: "text-emerald-400", level: "flush", prefix: "  ✔", text: "reconnected · 1 queued mutation sent" },
    { color: "text-sky-sapphire", level: "render", prefix: "  ↻", text: "client re-rendered (live)" },
];

const ClientTerminal = () => {
    const [visibleLines, setVisibleLines] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setVisibleLines((previous) => {
                if (previous >= LOG_LINES.length) {
                    // Reset after a pause
                    setTimeout(setVisibleLines, 800, 0);

                    return previous;
                }

                return previous + 1;
            });
        }, 1200);

        return () => {
            clearInterval(interval);
        };
    }, []);

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2.5">
                <div className="flex gap-1.5">
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                </div>
                <span className="font-mono text-[10px] tracking-wider text-white/20 uppercase">@lunora/client — live</span>
            </div>

            <div className="flex-1 overflow-hidden px-4 py-3 font-mono text-xs leading-6">
                <AnimatePresence mode="popLayout">
                    {LOG_LINES.slice(0, visibleLines).map((line, i) => (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className="flex items-baseline gap-0"
                            exit={{ opacity: 0, y: -4 }}
                            initial={{ opacity: 0, y: 6 }}
                            key={`${line.level}-${i}`}
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            <span className={cn("w-5 shrink-0", line.color)}>{line.prefix}</span>
                            <span className="ml-1 w-20 shrink-0 text-white/25">{line.level.padEnd(8)}</span>
                            <span className="text-white/60">{line.text}</span>
                        </motion.div>
                    ))}
                </AnimatePresence>

                <motion.span
                    animate={{ opacity: [1, 0] }}
                    className="inline-block h-3.5 w-1.5 translate-y-0.5 bg-crimson-energy/60"
                    transition={{ duration: 0.8, repeat: Infinity, repeatType: "reverse" }}
                />
            </div>
        </div>
    );
};

const ClientSection = () => (
    <Section classes={{ root: "pt-12" }} gridLength={0} mode="dark">
        <div className="col-span-3 flex flex-col bg-background">
            <div className="relative overflow-hidden border border-white/[0.08] bg-[hsl(240_16%_5%)]">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-crimson-energy/60 to-transparent" />
                <div className="grid grid-cols-2">
                    <div className="z-10 flex w-full flex-col gap-4 p-8">
                        <div className="flex items-center gap-3">
                            <span className="inline-block bg-crimson-energy/20 px-3 py-1 font-mono text-xs font-medium text-crimson-energy">Client</span>
                        </div>
                        <h3 className="text-2xl font-bold tracking-tight text-white">@lunora/client</h3>
                        <span className="text-sm leading-relaxed text-white/60">
                            The browser SDK that keeps your UI in sync. Live subscriptions over WebSocket, optimistic updates that apply instantly, and an
                            offline queue that flushes the moment you reconnect.
                        </span>
                        <div className="mt-auto pt-6">
                            <Link
                                className="inline-flex items-center gap-2 bg-crimson-energy/20 px-3 py-1.5 text-sm font-medium text-crimson-energy transition-colors hover:bg-crimson-energy/30 hover:text-white"
                                params={{ slug: "client" }}
                                to="/packages/$slug"
                            >
                                Explore @lunora/client
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                        </div>
                    </div>

                    <div className="min-h-80 w-full border-l border-white/[0.08] bg-[hsl(240_16%_4%)]">
                        <ClientTerminal />
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-2 border-x border-white/[0.08]">
                <FeatureCard accentColor="bg-crimson-energy/40" title="Live by default">
                    Queries are subscriptions. When a mutation changes the data a query reads, every connected client re-renders automatically — no polling, no
                    manual cache invalidation.
                </FeatureCard>
                <FeatureCard accentColor="bg-crimson-energy/40" className="border-l border-white/[0.08]" title="Optimistic updates">
                    Mutations apply locally the instant you call them, then reconcile with the server's authoritative result. Your UI feels instant even at the
                    edge.
                </FeatureCard>
            </div>
            <div className="grid grid-cols-2 border-x border-b border-white/[0.08]">
                <FeatureCard accentColor="bg-crimson-energy/40" className="border-t border-white/[0.08]" title="Offline queue">
                    Lose connection and mutations are durably queued on the client. Reconnect and they flush in order, keyed by client id so retries stay
                    idempotent.
                </FeatureCard>
                <FeatureCard accentColor="bg-crimson-energy/40" className="border-t border-l border-white/[0.08]" title="Framework adapters">
                    First-class hooks and stores for React, Vue, Solid, and Svelte — all built on the same typed client and generated API.
                </FeatureCard>
            </div>
        </div>
    </Section>
);

const CLI_SEQUENCE = [
    {
        command: "const msgs = useQuery",
        flags: "(api.messages.list)",
        output: [
            { color: "text-royal-amethyst", text: "subscribing over WebSocket..." },
            { color: "text-white/40", text: "  ● Ada      Hello from the edge" },
            { color: "text-white/40", text: "  ● Grace    Types just synced 🎉" },
            { color: "text-white/40", text: "  ↻ re-renders on every change" },
            { color: "text-emerald-400", text: "✔ live data, fully typed" },
        ],
    },
    {
        command: "const send = useMutation",
        flags: "(api.messages.send)",
        output: [
            { color: "text-royal-amethyst", text: 'send({ body: "Shipping it" })' },
            { color: "text-white/40", text: "  applied optimistically" },
            { color: "text-white/40", text: "  awaiting Durable Object..." },
            { color: "text-white/40", text: "  confirmed & reconciled" },
            { color: "text-emerald-400", text: "✔ mutation committed" },
        ],
    },
];

const ReactTerminal = () => {
    const [phase, setPhase] = useState<"typing-cmd" | "typing-flags" | "output" | "done">("typing-cmd");
    const [seqIndex, setSeqIndex] = useState(0);
    const [charIndex, setCharIndex] = useState(0);
    const [outputIndex, setOutputIndex] = useState(0);

    const seq = CLI_SEQUENCE[seqIndex % CLI_SEQUENCE.length];

    useEffect(() => {
        if (phase === "typing-cmd") {
            if (charIndex < seq.command.length) {
                const timer = setTimeout(
                    () => {
                        setCharIndex((c) => c + 1);
                    },
                    60 + Math.random() * 40,
                );

                return () => {
                    clearTimeout(timer);
                };
            }

            const timer = setTimeout(() => {
                setCharIndex(0);
                setPhase("typing-flags");
            }, 200);

            return () => {
                clearTimeout(timer);
            };
        }

        if (phase === "typing-flags") {
            if (charIndex < seq.flags.length) {
                const timer = setTimeout(
                    () => {
                        setCharIndex((c) => c + 1);
                    },
                    45 + Math.random() * 30,
                );

                return () => {
                    clearTimeout(timer);
                };
            }

            const timer = setTimeout(() => {
                setPhase("output");
                setOutputIndex(0);
            }, 400);

            return () => {
                clearTimeout(timer);
            };
        }

        if (phase === "output") {
            if (outputIndex < seq.output.length) {
                const timer = setTimeout(() => {
                    setOutputIndex((o) => o + 1);
                }, 500);

                return () => {
                    clearTimeout(timer);
                };
            }

            const timer = setTimeout(setPhase, 1500, "done");

            return () => {
                clearTimeout(timer);
            };
        }

        if (phase === "done") {
            const timer = setTimeout(() => {
                setSeqIndex((s) => s + 1);
                setCharIndex(0);
                setOutputIndex(0);
                setPhase("typing-cmd");
            }, 1000);

            return () => {
                clearTimeout(timer);
            };
        }
    }, [phase, charIndex, outputIndex, seq]);

    const typedCommand = phase === "typing-cmd" ? seq.command.slice(0, charIndex) : seq.command;
    const typedFlags = phase === "typing-flags" ? seq.flags.slice(0, charIndex) : phase === "typing-cmd" ? "" : seq.flags;
    const showCursor = phase === "typing-cmd" || phase === "typing-flags";

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2.5">
                <div className="flex gap-1.5">
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                    <div className="h-2 w-2 bg-white/10" />
                </div>
                <span className="font-mono text-[10px] tracking-wider text-white/20 uppercase">@lunora/react — hooks</span>
            </div>

            <div className="flex-1 overflow-hidden px-4 py-3 font-mono text-xs leading-6">
                <div className="flex flex-wrap">
                    <span className="text-royal-amethyst/60">›</span>
                    <span className="ml-2 text-white/80">{typedCommand}</span>
                    {typedFlags && <span className="ml-1 text-white/40">{typedFlags}</span>}
                    {showCursor && (
                        <motion.span
                            animate={{ opacity: [1, 0] }}
                            className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-royal-amethyst/60"
                            transition={{ duration: 0.6, repeat: Infinity, repeatType: "reverse" }}
                        />
                    )}
                </div>

                <AnimatePresence>
                    {(phase === "output" || phase === "done") &&
                        seq.output.slice(0, outputIndex).map((line, i) => (
                            <motion.div
                                animate={{ opacity: 1, x: 0 }}
                                className={line.color}
                                initial={{ opacity: 0, x: -4 }}
                                key={`${seqIndex}-${i}`}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                            >
                                {line.text}
                            </motion.div>
                        ))}
                </AnimatePresence>
            </div>
        </div>
    );
};

const ReactSection = () => (
    <Section classes={{ root: "pt-12" }} gridLength={0} mode="dark">
        <div className="hidden lg:col-span-1 lg:block" />
        <div className="col-span-4 -ml-px flex flex-col xl:col-span-3 bg-background">
            <div className="relative overflow-hidden border border-white/[0.08] bg-[hsl(240_16%_5%)]">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-royal-amethyst/60 to-transparent" />
                <div className="grid grid-cols-2">
                    <div className="min-h-80 w-full bg-[hsl(240_16%_4%)]">
                        <ReactTerminal />
                    </div>
                    <div className="z-10 flex w-full flex-col gap-4 p-8 border-l border-white/[0.08]">
                        <div className="flex items-center gap-3">
                            <span className="inline-block bg-royal-amethyst/20 px-3 py-1 font-mono text-xs font-medium text-royal-amethyst">Adapters</span>
                        </div>
                        <h3 className="text-2xl font-bold tracking-tight text-white">@lunora/react</h3>
                        <span className="text-sm leading-relaxed text-white/60">
                            Drop-in hooks that bind your generated API straight into components. <code className="text-royal-amethyst/80">useQuery</code>,{" "}
                            <code className="text-royal-amethyst/80">useMutation</code>, <code className="text-royal-amethyst/80">useSubscription</code>, and{" "}
                            <code className="text-royal-amethyst/80">useAuth</code> — all fully typed.
                        </span>
                        <div className="mt-auto pt-6">
                            <Link
                                className="inline-flex items-center gap-2 bg-royal-amethyst/20 px-3 py-1.5 text-sm font-medium text-royal-amethyst transition-colors hover:bg-royal-amethyst/30 hover:text-white"
                                params={{ slug: "react" }}
                                to="/packages/$slug"
                            >
                                Explore @lunora/react
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-2 border-x border-white/[0.08]">
                <FeatureCard accentColor="bg-royal-amethyst/40" title="Inferred end-to-end">
                    Hook arguments and results infer their types straight from your server functions through the generated{" "}
                    <code className="text-royal-amethyst/80">api</code> — rename a field on the server and the client stops compiling.
                </FeatureCard>
                <FeatureCard accentColor="bg-royal-amethyst/40" className="border-l border-white/[0.08]" title="Reactive loaders">
                    Queries subscribe automatically and tear down on unmount. Components stay in sync with server state without{" "}
                    <code className="text-royal-amethyst/80">useEffect</code> plumbing.
                </FeatureCard>
            </div>
            <div className="grid grid-cols-2 border-x border-b border-white/[0.08]">
                <FeatureCard accentColor="bg-royal-amethyst/40" className="border-t border-white/[0.08]" title="Optimistic mutations">
                    Pass an optimistic updater to <code className="text-royal-amethyst/80">useMutation</code> and the UI updates instantly, then reconciles with
                    the server's confirmed result.
                </FeatureCard>
                <FeatureCard accentColor="bg-royal-amethyst/40" className="border-t border-l border-white/[0.08]" title="Pick your framework">
                    Prefer Vue, Solid, or Svelte? The same patterns ship as <code className="text-royal-amethyst/80">@lunora/vue</code>,{" "}
                    <code className="text-royal-amethyst/80">@lunora/solid</code>, and <code className="text-royal-amethyst/80">@lunora/svelte</code>.
                </FeatureCard>
            </div>
        </div>
    </Section>
);

const Packages: FC = () => (
    <div className="bg-background">
        <SectionDivider />
        <Section classes={{ childrenWrapper: "items-end", root: "pb-20" }} gridLength={0} mode="dark">
            <SectionHeader
                className="col-span-2"
                eyebrow="Packages"
                subhead="From the schema-first server to the live browser client and framework adapters — everything for a real-time, end-to-end typed backend on Cloudflare."
                title="Everything for a real-time backend."
            />
            <div className="hidden lg:col-span-1 lg:block" />
            <div className="col-span-1">
                <HighlightLink className="-ml-px w-[calc(100%+1px)] border-r-0" icon={<ChevronRight />} mode="dark" to="/packages">
                    Explore Packages
                </HighlightLink>
            </div>
        </Section>
        <ServerSection />
        <ClientSection />
        <ReactSection />
        <Section classes={{ root: "pt-12" }} gridLength={0} mode="dark">
            <div className="col-span-1 hidden lg:block" />
            <div className="col-span-2 flex flex-col gap-16">
                <SectionHeader
                    align="center"
                    subhead="Define your vision, design with elegance, and deploy solutions that shape the future of the web — with confidence."
                    title="Define, design, deploy what's next for the web"
                />
                <HighlightLink className="-ml-[2px] w-[calc(100%+1px)] border-r-0 bg-background" icon={<ChevronRight />} mode="dark" to="/packages">
                    Start Building
                </HighlightLink>
            </div>
        </Section>
    </div>
);

export default Packages;
