"use client";

import { Check, Copy, Plus } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { FC, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import Section from "@/components/sections/section";
import { cn } from "@/lib/utils";

const KEYWORD = /^(import|from|const|await|export|async|function|type|default|return)$/;
const WHITESPACE = /^\s+$/;
const STRING_START = /^["'`]/;
const PUNCTUATION = /^[{}()[\];,=>:.]+$/;
const NUMBER = /^\d+$/;
const BOOLEAN = /^(true|false|null|undefined)$/;

const CodeLine: FC<{ content: string }> = ({ content }) => {
    if (!content.trim()) {
        return <span>&nbsp;</span>;
    }

    return (
        <span>
            {content.split(/(\s+)/).map((segment, index) => {
                if (WHITESPACE.test(segment)) {
                    return <span key={index}>{segment}</span>;
                }

                if (!segment) {
                    return null;
                }

                let colorClass = "text-white/55";

                if (KEYWORD.test(segment)) colorClass = "text-crimson-energy/70";
                else if (STRING_START.test(segment)) colorClass = "text-sky-sapphire/75";
                else if (PUNCTUATION.test(segment)) colorClass = "text-white/25";
                else if (NUMBER.test(segment) || BOOLEAN.test(segment)) colorClass = "text-sky-sapphire/60";

                return (
                    <span className={colorClass} key={index}>
                        {segment}
                    </span>
                );
            })}
        </span>
    );
};

const tabs = {
    "schema.ts": [
        "import { defineSchema, defineTable, v }",
        '  from "lunora/server";',
        "",
        "export default defineSchema({",
        "  todos: defineTable({",
        "    text: v.string(),",
        "    category: v.optional(v.string()),",
        "    completed: v.boolean(),",
        '  }).index("by_completed", ["completed"]),',
        "});",
    ],
    "todos.ts": [
        'import { mutation, query, v } from "lunora/server";',
        "",
        "export const list = query.query(",
        "  async ({ ctx }) =>",
        '    ctx.db.query("todos").collect(),',
        ");",
        "",
        "export const add = mutation",
        "  .input({ text: v.string(), category: v.string() })",
        "  .mutation(async ({ ctx, args }) =>",
        '    ctx.db.insert("todos", { ...args, completed: false }),',
        "  );",
        "",
        "export const toggle = mutation",
        '  .input({ id: v.id("todos") })',
        "  .mutation(async ({ ctx, args }) =>",
        "    ctx.db.patch(args.id, { completed: true }),",
        "  );",
    ],
} as const;

type TabName = keyof typeof tabs;

const categoryTone: Record<string, string> = {
    Chores: "bg-amber-400/15 text-amber-300",
    Health: "bg-emerald-400/15 text-emerald-300",
    Other: "bg-white/10 text-white/55",
    Work: "bg-royal-amethyst/25 text-[hsl(282_60%_75%)]",
};

interface Todo {
    category: string;
    completed: boolean;
    docId: string;
    fresh: boolean;
    id: number;
    text: string;
}

const makeDocId = (n: number): string => `k${((n + 3) * 48271 + 7).toString(36).padStart(7, "0").slice(0, 9)}`;

const HEALTH_WORDS = /gym|run|exercise|walk|workout|sleep|cook|dinner|health|yoga|meditat|water/i;
const WORK_WORDS = /work|boss|sprint|post|meeting|email|deploy|ship|launch|review|standup|client|pr\b/i;
const CHORES_WORDS = /groc|clean|dog|laundry|dishes|chore|shop|trash|errand|fix|tidy/i;

const categorize = (text: string): string => {
    if (HEALTH_WORDS.test(text)) return "Health";
    if (WORK_WORDS.test(text)) return "Work";
    if (CHORES_WORDS.test(text)) return "Chores";

    return "Other";
};

const seedTodos: Omit<Todo, "fresh">[] = [
    { category: "Other", completed: false, docId: makeDocId(0), id: 0, text: "Play basketball" },
    { category: "Work", completed: false, docId: makeDocId(1), id: 1, text: "Talk to my boss" },
    { category: "Chores", completed: false, docId: makeDocId(2), id: 2, text: "Buy groceries" },
];

const incoming: { category: string; text: string }[] = [
    { category: "Health", text: "Exercise at the gym" },
    { category: "Work", text: "Write the launch post" },
    { category: "Chores", text: "Walk the dog" },
    { category: "Work", text: "Plan the next sprint" },
    { category: "Health", text: "Cook a real dinner" },
];

const randomPool: { category: string; text: string }[] = [
    ...incoming,
    { category: "Work", text: "Review the pull request" },
    { category: "Chores", text: "Take out the trash" },
    { category: "Health", text: "Go for a morning run" },
    { category: "Other", text: "Read a chapter" },
    { category: "Work", text: "Reply to the standup thread" },
    { category: "Chores", text: "Do the laundry" },
    { category: "Health", text: "Drink more water" },
    { category: "Other", text: "Call an old friend" },
];

const pickRandom = (): { category: string; text: string } => randomPool[Math.floor(Math.random() * randomPool.length)];

const CategoryBadge: FC<{ category: string }> = ({ category }) => (
    <span className={cn("shrink-0 px-2 py-0.5 text-[11px] font-medium", categoryTone[category] ?? categoryTone.Other)}>{category}</span>
);

const ColumnHeader: FC<{ accent?: ReactNode; active: boolean; label: string; right?: ReactNode }> = ({ accent, active, label, right }) => (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/[0.08] px-3">
        <span className="flex items-center gap-2">
            {accent}
            <span className={cn("font-mono text-[11px] tracking-wide transition-colors", active ? "text-sky-sapphire" : "text-white/40")}>{label}</span>
        </span>
        {right}
    </div>
);

const CodeColumn: FC<{ focused: boolean; writing: boolean }> = ({ focused, writing }) => {
    const [active, setActive] = useState<TabName>("todos.ts");
    const lines = tabs[active];

    return (
        <div className={cn("flex min-h-0 flex-col transition-colors duration-500", focused && "bg-sky-sapphire/[0.03]")}>
            <div className="flex h-9 shrink-0 items-stretch border-b border-white/[0.08]">
                {(Object.keys(tabs) as TabName[]).map((name) => (
                    <button
                        className={cn(
                            "border-r border-white/[0.06] px-3 font-mono text-[11px] tracking-wide transition-colors",
                            active === name ? "bg-white/[0.04] text-white/80" : "text-white/35 hover:text-white/60",
                        )}
                        key={name}
                        onClick={() => {
                            setActive(name);
                        }}
                        type="button"
                    >
                        {name}
                    </button>
                ))}
            </div>
            <div className="grow overflow-auto px-4 py-4 font-mono text-[13px] leading-[1.9]">
                {lines.map((line, index) => (
                    <div
                        className={cn(
                            "-mx-1 flex px-1 transition-colors duration-300",
                            writing && active === "todos.ts" && index >= 7 && index <= 11 ? "bg-sky-sapphire/[0.08]" : "",
                        )}
                        key={index}
                    >
                        <span className="mr-3 w-4 shrink-0 text-right text-white/[0.15] select-none">{index + 1}</span>
                        <CodeLine content={line} />
                    </div>
                ))}
            </div>
        </div>
    );
};

const AppColumn: FC<{
    focused: boolean;
    inputValue: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onToggle: (id: number) => void;
    placeholder: string;
    showHint: boolean;
    todos: Todo[];
}> = ({ focused, inputValue, onChange, onSubmit, onToggle, placeholder, showHint, todos }) => {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = listRef.current;

        if (element) {
            element.scrollTo({ behavior: "smooth", top: element.scrollHeight });
        }
    }, [todos.length]);

    return (
        <div className={cn("flex min-h-0 flex-col transition-colors duration-500", focused && "bg-sky-sapphire/[0.03]")}>
            <ColumnHeader
                active={focused}
                label="app · my-todo-app"
                right={
                    <AnimatePresence>
                        {showHint && (
                            <motion.span
                                animate={{ opacity: 1 }}
                                className="bg-amber-300/90 px-2 py-0.5 text-[10px] font-semibold tracking-tight text-coal"
                                exit={{ opacity: 0 }}
                                initial={{ opacity: 0 }}
                            >
                                Try it ↓
                            </motion.span>
                        )}
                    </AnimatePresence>
                }
            />
            <div className="min-h-0 grow space-y-1.5 overflow-y-auto px-4 py-3" ref={listRef}>
                <AnimatePresence initial={false}>
                    {todos.map((todo) => (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className="flex items-center gap-3 px-1 py-1.5"
                            exit={{ opacity: 0 }}
                            initial={{ opacity: 0, y: -8 }}
                            key={todo.id}
                            layout
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            <button
                                aria-label={todo.completed ? "Mark incomplete" : "Mark complete"}
                                className={cn(
                                    "flex size-4 shrink-0 cursor-pointer items-center justify-center border transition-colors",
                                    todo.completed ? "border-emerald-400/60 bg-emerald-400/20" : "border-white/20 hover:border-white/40",
                                )}
                                onClick={() => {
                                    onToggle(todo.id);
                                }}
                                type="button"
                            >
                                {todo.completed && <Check className="size-3 text-emerald-400" />}
                            </button>
                            <span className={cn("flex-1 truncate text-sm", todo.completed ? "text-white/30 line-through" : "text-white/75")}>{todo.text}</span>
                            <CategoryBadge category={todo.category} />
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
            <div className="flex items-center gap-2 border-t border-white/[0.08] p-2.5">
                <input
                    className="min-w-0 flex-1 bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none transition-colors placeholder:text-white/30 focus:bg-white/[0.06] focus:ring-1 focus:ring-white/15"
                    onChange={(event) => {
                        onChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            onSubmit();
                        }
                    }}
                    placeholder={placeholder}
                    value={inputValue}
                />
                <button
                    className="inline-flex shrink-0 items-center gap-1.5 bg-white px-3 py-2 text-xs font-semibold text-coal transition-colors hover:bg-white/90"
                    onClick={onSubmit}
                    type="button"
                >
                    <Plus className="size-3.5" />
                    Add
                </button>
            </div>
        </div>
    );
};

const TableColumn: FC<{ focused: boolean; todos: Todo[] }> = ({ focused, todos }) => (
    <div className={cn("flex min-h-0 flex-col transition-colors duration-500", focused && "bg-sky-sapphire/[0.03]")}>
        <ColumnHeader
            accent={<span className="size-2 bg-crimson-energy/70" />}
            active={focused}
            label="studio · todos"
            right={<span className="font-mono text-[10px] text-white/30">{todos.length} docs</span>}
        />
        <div className="grow overflow-auto px-2 py-1">
            <table className="w-full border-separate border-spacing-0 text-left font-mono text-[12px]">
                <thead>
                    <tr className="text-white/35">
                        {["_id", "text", "category", "done"].map((col) => (
                            <th className="px-2 py-1.5 font-normal" key={col}>
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    <AnimatePresence initial={false}>
                        {todos.map((todo) => (
                            <motion.tr
                                animate={{ backgroundColor: todo.fresh ? "hsl(210 100% 45% / 0.1)" : "hsl(210 100% 45% / 0)" }}
                                className="text-white/55"
                                initial={{ backgroundColor: "hsl(210 100% 45% / 0.18)" }}
                                key={todo.id}
                                transition={{ duration: 1.2 }}
                            >
                                <td className="truncate px-2 py-1.5 text-white/30">{todo.docId}</td>
                                <td className="max-w-[6rem] truncate px-2 py-1.5 text-sky-sapphire/70">&quot;{todo.text}&quot;</td>
                                <td className="px-2 py-1.5 text-sky-sapphire/70">&quot;{todo.category}&quot;</td>
                                <td className={cn("px-2 py-1.5", todo.completed ? "text-emerald-400/80" : "text-white/40")}>{String(todo.completed)}</td>
                            </motion.tr>
                        ))}
                    </AnimatePresence>
                </tbody>
            </table>
        </div>
    </div>
);

const LunoraConsole: FC<{ focus: number }> = ({ focus }) => {
    const [todos, setTodos] = useState<Todo[]>(() => seedTodos.map((todo) => ({ ...todo, fresh: false })));
    const [writing, setWriting] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [engaged, setEngaged] = useState(false);
    const [suggestion, setSuggestion] = useState(randomPool[0]);
    const reduce = useReducedMotion();
    const cursorRef = useRef(0);
    const idRef = useRef(seedTodos.length);
    const tickRef = useRef(0);
    const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

    const settle = useCallback((id: number) => {
        const settleId = setTimeout(() => {
            setTodos((previous) => previous.map((todo) => (todo.id === id ? { ...todo, fresh: false } : todo)));
        }, 1400);

        timeoutsRef.current.push(settleId);
    }, []);

    const pushTodo = useCallback(
        (text: string, category: string) => {
            const id = idRef.current;
            idRef.current += 1;

            setTodos((previous) => [...previous, { category, completed: false, docId: makeDocId(id), fresh: true, id, text }].slice(-12));
            settle(id);
        },
        [settle],
    );

    const autoAdd = useCallback(() => {
        setWriting(true);

        const item = incoming[cursorRef.current % incoming.length];
        cursorRef.current += 1;

        const appendId = setTimeout(() => {
            pushTodo(item.text, item.category);
            setWriting(false);
        }, 460);

        timeoutsRef.current.push(appendId);
    }, [pushTodo]);

    const handleChange = useCallback((value: string) => {
        setInputValue(value);
        setEngaged(true);
    }, []);

    const toggleTodo = useCallback(
        (id: number) => {
            setEngaged(true);
            setTodos((previous) => previous.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed, fresh: true } : todo)));
            settle(id);
        },
        [settle],
    );

    const handleSubmit = useCallback(() => {
        const text = inputValue.trim();

        setWriting(true);
        setEngaged(true);

        if (text) {
            pushTodo(text, categorize(text));
        } else {
            pushTodo(suggestion.text, suggestion.category);
            setSuggestion(pickRandom());
        }

        setInputValue("");

        const stopWriting = setTimeout(() => {
            setWriting(false);
        }, 500);

        timeoutsRef.current.push(stopWriting);
    }, [inputValue, pushTodo, suggestion]);

    useEffect(() => {
        setSuggestion(pickRandom());
    }, []);

    useEffect(() => {
        // Pause the auto-playing demo once the user takes over, or when they
        // prefer reduced motion (the panels stay fully interactive). DESIGN.md §5.
        if (engaged || reduce) {
            return () => {
                timeoutsRef.current.forEach(clearTimeout);
                timeoutsRef.current = [];
            };
        }

        const toggleNext = () => {
            setTodos((previous) => {
                const target = [...previous].reverse().find((todo) => !todo.completed);

                if (!target) {
                    return previous;
                }

                settle(target.id);

                return previous.map((todo) => (todo.id === target.id ? { ...todo, completed: true, fresh: true } : todo));
            });
        };

        const interval = setInterval(() => {
            tickRef.current += 1;

            if (tickRef.current % 3 === 0) {
                toggleNext();
            } else {
                autoAdd();
            }
        }, 2900);

        return () => {
            clearInterval(interval);
            timeoutsRef.current.forEach(clearTimeout);
            timeoutsRef.current = [];
        };
    }, [engaged, reduce, autoAdd, settle]);

    return (
        <div className="grid h-auto grid-cols-1 divide-y divide-white/[0.08] bg-[hsl(240_16%_5%)] lg:h-[34rem] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            <CodeColumn focused={focus === 0} writing={writing} />
            <AppColumn
                focused={focus === 1}
                inputValue={inputValue}
                onChange={handleChange}
                onSubmit={handleSubmit}
                onToggle={toggleTodo}
                placeholder={suggestion.text}
                showHint={!engaged}
                todos={todos}
            />
            <TableColumn focused={focus === 1 || focus === 2} todos={todos} />
        </div>
    );
};

const features = [
    { description: "Schema, queries, and mutations in pure TypeScript — typed end-to-end and generated for you.", title: "Everything is code" },
    { description: "useQuery subscribes once. Every mutation pushes live updates to all clients — no refetching.", title: "Always in sync" },
    { description: "Durable Objects, edge runtime, SQLite, and global replication — production-ready by default.", title: "Built on Cloudflare" },
];

const fade = (delay: number) => ({
    animate: { opacity: 1, y: 0 },
    initial: { opacity: 0, y: 16 },
    transition: { delay, duration: 0.6, ease: "easeOut" as const },
});

const MainHero: FC = () => {
    const [activeFeature, setActiveFeature] = useState(0);
    const [copied, setCopied] = useState(false);

    const copyCommand = () => {
        void navigator.clipboard.writeText("npx lunora init my-app");
        setCopied(true);
        setTimeout(() => {
            setCopied(false);
        }, 1500);
    };

    return (
        <div className="relative overflow-hidden bg-background">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[40rem]"
                style={{ background: "radial-gradient(60% 50% at 50% -5%, hsl(256 72% 68% / 0.14), transparent 70%)" }}
            />
            <Section
                classes={{
                    childrenWrapper: "!grid-cols-1",
                    root: "!pt-40 !pb-16 sm:!pt-52",
                }}
                gridLength={0}
                mode="dark"
            >
                <div className="relative z-10 flex w-full flex-col">
                    <p className="sr-only">
                        Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer experience.
                        Define a schema and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live
                        subscriptions, optimistic updates, and an offline queue — types sync from server to client automatically via codegen.
                    </p>

                    {/* headline */}
                    <motion.h1
                        {...fade(0.1)}
                        className="font-display max-w-4xl text-5xl leading-[1.06] font-medium tracking-tight text-balance text-white sm:text-6xl lg:text-7xl"
                    >
                        Realtime backends, end-to-end typed{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">
                            on Cloudflare&apos;s edge.
                        </span>
                    </motion.h1>

                    {/* description + install, in a row below the headline */}
                    <motion.div {...fade(0.2)} className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                        <p className="max-w-sm text-sm leading-relaxed text-white/55 sm:text-base">
                            Typed queries, live sync, optimistic updates, and offline — global by default on Workers &amp; Durable Objects.
                        </p>
                        <button
                            className="group flex w-fit shrink-0 items-center gap-3 border-[0.75px] border-white/15 bg-white/[0.03] px-4 py-2.5 font-mono text-sm text-white/70 transition-colors hover:border-white/25 hover:text-white"
                            onClick={copyCommand}
                            type="button"
                        >
                            <span className="text-white/30 select-none">$</span>
                            npx lunora init my-app
                            {copied ? (
                                <Check className="size-4 text-emerald-400" />
                            ) : (
                                <Copy className="size-4 text-white/30 transition-colors group-hover:text-white/60" />
                            )}
                        </button>
                    </motion.div>

                    {/* console + feature strip, on an aurora pedestal */}
                    <div className="relative mt-16">
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute -inset-x-16 top-1/3 bottom-[-12%] -z-0 blur-3xl"
                            style={{ background: "radial-gradient(ellipse at 50% 95%, hsl(256 72% 68% / 0.28), hsl(186 84% 56% / 0.10) 45%, transparent 72%)" }}
                        />
                        <motion.div {...fade(0.4)} className="relative z-10 border border-white/10 shadow-2xl shadow-black/60">
                            <LunoraConsole focus={activeFeature} />
                            <div className="grid grid-cols-1 divide-y divide-white/[0.08] border-t border-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                                {features.map((feature, index) => {
                                    const isActive = index === activeFeature;

                                    return (
                                        <button
                                            className={cn(
                                                "relative flex flex-col gap-1.5 p-4 text-left transition-colors",
                                                isActive ? "bg-white/[0.03]" : "hover:bg-white/[0.015]",
                                            )}
                                            key={feature.title}
                                            onClick={() => {
                                                setActiveFeature(index);
                                            }}
                                            onMouseEnter={() => {
                                                setActiveFeature(index);
                                            }}
                                            type="button"
                                        >
                                            {isActive && (
                                                <motion.span
                                                    className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy"
                                                    layoutId="feature-accent"
                                                />
                                            )}
                                            <span className="flex items-center gap-2">
                                                <span
                                                    className={cn(
                                                        "font-mono text-[11px] tabular-nums transition-colors",
                                                        isActive ? "text-sky-sapphire" : "text-white/30",
                                                    )}
                                                >
                                                    {String(index + 1).padStart(2, "0")}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "text-sm font-medium tracking-tight transition-colors",
                                                        isActive ? "text-white" : "text-white/55",
                                                    )}
                                                >
                                                    {feature.title}
                                                </span>
                                            </span>
                                            <span className="text-xs leading-snug text-white/45">{feature.description}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </motion.div>
                    </div>
                </div>
            </Section>
        </div>
    );
};

export default MainHero;
