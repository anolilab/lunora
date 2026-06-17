"use client";

import { Check, Copy, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
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
        "export const list = query({",
        '  handler: (ctx) => ctx.db.query("todos"),',
        "});",
        "",
        "export const add = mutation({",
        "  args: { text: v.string(), category: v.string() },",
        "  handler: (ctx, t) =>",
        '    ctx.db.insert("todos", { ...t, completed: false }),',
        "});",
        "",
        "export const toggle = mutation({",
        '  args: { id: v.id("todos") },',
        "  handler: (ctx, { id }) =>",
        "    ctx.db.patch(id, { completed: true }),",
        "});",
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
    <span className={cn("shrink-0 rounded px-2 py-0.5 text-[11px] font-medium", categoryTone[category] ?? categoryTone.Other)}>{category}</span>
);

const WindowChrome: FC<{ label: string; tone?: "studio" }> = ({ label, tone }) => (
    <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-white/[0.08]" />
            <span className="size-2.5 rounded-full bg-white/[0.08]" />
            <span className="size-2.5 rounded-full bg-white/[0.08]" />
        </span>
        <span className="mx-auto flex items-center gap-1.5 rounded bg-white/[0.04] px-3 py-0.5 font-mono text-[11px] text-white/35">
            {tone === "studio" && <span className="size-2 rounded-full bg-crimson-energy/70" />}
            {label}
        </span>
    </div>
);

const CodePanel: FC<{ focused: boolean; writing: boolean }> = ({ focused, writing }) => {
    const [active, setActive] = useState<TabName>("todos.ts");
    const lines = tabs[active];

    return (
        <div
            className={cn(
                "flex h-full flex-col overflow-hidden rounded-lg bg-[hsl(220_14%_6%)] transition-shadow duration-500",
                focused && "ring-1 ring-sky-sapphire/40",
            )}
        >
            <WindowChrome label="lunora — editor" />
            <div className="flex items-center gap-1 px-2 text-xs">
                {(Object.keys(tabs) as TabName[]).map((name) => (
                    <button
                        className={cn(
                            "flex items-center gap-1.5 border-b-2 px-2.5 py-2 font-mono text-[11px] transition-colors",
                            active === name
                                ? "border-b-sky-sapphire/70 bg-white/[0.04] text-white/80"
                                : "border-b-transparent text-white/35 hover:text-white/60",
                        )}
                        key={name}
                        onClick={() => {
                            setActive(name);
                        }}
                        type="button"
                    >
                        <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-sky-sapphire/20 font-bold text-sky-sapphire/80">TS</span>
                        lunora/{name}
                    </button>
                ))}
            </div>
            <div className="grow overflow-auto bg-[hsl(220_16%_4.5%)] px-3 py-3 font-mono text-[12px] leading-[1.75]">
                {lines.map((line, index) => (
                    <div
                        className={cn(
                            "-mx-1 flex rounded-sm px-1 transition-colors duration-300",
                            writing && active === "todos.ts" && index >= 6 && index <= 10 ? "bg-sky-sapphire/[0.08]" : "",
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

const TodoAppPanel: FC<{
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
        <div
            className={cn(
                "flex min-h-0 flex-col overflow-hidden rounded-lg bg-[hsl(220_14%_8%)] transition-shadow duration-500",
                focused && "ring-1 ring-sky-sapphire/40",
            )}
        >
            <WindowChrome label="my-todo-app.app" />
            <div className="flex items-center justify-between px-4 pt-1 pb-2">
                <span className="text-sm font-medium text-white/80">Todos</span>
                <AnimatePresence>
                    {showHint && (
                        <motion.span
                            animate={{ opacity: 1, x: 0 }}
                            className="flex items-center gap-1 bg-amber-300/90 px-2 py-0.5 text-[10px] font-semibold tracking-tight text-coal"
                            exit={{ opacity: 0 }}
                            initial={{ opacity: 0, x: 6 }}
                        >
                            Try it — add a todo
                        </motion.span>
                    )}
                </AnimatePresence>
            </div>
            <div className="min-h-0 grow space-y-1 overflow-y-auto px-3" ref={listRef}>
                <AnimatePresence initial={false}>
                    {todos.map((todo) => (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className="flex items-center gap-3 rounded-md px-2 py-2"
                            exit={{ opacity: 0 }}
                            initial={{ opacity: 0, y: -8 }}
                            key={todo.id}
                            layout
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            <button
                                aria-label={todo.completed ? "Mark incomplete" : "Mark complete"}
                                className={cn(
                                    "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors",
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
            <div className="flex items-center gap-2 p-3">
                <input
                    className="flex-1 rounded-md bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none transition-colors placeholder:text-white/30 focus:bg-white/[0.06] focus:ring-1 focus:ring-white/15"
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
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-white px-3 py-2 text-xs font-semibold text-coal transition-colors hover:bg-white/90"
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

const StudioTablePanel: FC<{ focused: boolean; todos: Todo[] }> = ({ focused, todos }) => (
    <div
        className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-lg bg-[hsl(220_14%_8%)] transition-shadow duration-500",
            focused && "ring-1 ring-sky-sapphire/40",
        )}
    >
        <WindowChrome label="lunora studio" tone="studio" />
        <div className="flex items-baseline gap-2 px-4 pt-1 pb-2">
            <span className="font-mono text-sm font-medium text-white/80">todos</span>
            <span className="text-[11px] text-white/35">
                table · {todos.length} document{todos.length === 1 ? "" : "s"}
            </span>
        </div>
        <div className="grow overflow-auto px-2 pb-2">
            <table className="w-full border-separate border-spacing-0 text-left font-mono text-[11px]">
                <thead>
                    <tr className="text-white/35">
                        {["_id", "text", "category", "completed"].map((col) => (
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
                                <td className="max-w-[7rem] truncate px-2 py-1.5 text-sky-sapphire/70">&quot;{todo.text}&quot;</td>
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

const LunoraDemo: FC<{ focus: number }> = ({ focus }) => {
    const [todos, setTodos] = useState<Todo[]>(() => seedTodos.map((todo) => ({ ...todo, fresh: false })));
    const [writing, setWriting] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [engaged, setEngaged] = useState(false);
    const [suggestion, setSuggestion] = useState(randomPool[0]);
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
        if (engaged) {
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
    }, [engaged, autoAdd, settle]);

    return (
        <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-white/[0.025] p-2.5 shadow-2xl shadow-black/40 ring-1 ring-white/[0.06]"
            initial={{ opacity: 0, y: 30 }}
            transition={{ delay: 0.5, duration: 0.8, ease: "easeOut" }}
        >
            <div className="grid h-[28rem] grid-cols-1 gap-2.5 lg:h-[36rem] lg:grid-cols-2">
                <CodePanel focused={focus === 0} writing={writing} />
                <div className="grid min-h-0 grid-rows-2 gap-2.5">
                    <TodoAppPanel
                        focused={focus === 1}
                        inputValue={inputValue}
                        onChange={handleChange}
                        onSubmit={handleSubmit}
                        onToggle={toggleTodo}
                        placeholder={suggestion.text}
                        showHint={!engaged}
                        todos={todos}
                    />
                    <StudioTablePanel focused={focus === 1 || focus === 2} todos={todos} />
                </div>
            </div>
        </motion.div>
    );
};

const features = [
    {
        description: "Schema, queries, mutations, and auth in pure TypeScript — typed end-to-end and generated for you by codegen.",
        title: "Everything is code",
    },
    { description: "useQuery subscribes once. Every mutation pushes live updates to all clients — no refetching, no glue code.", title: "Always in sync" },
    {
        description: "Durable Objects, edge runtime, SQLite, scheduling, and global replication — production-ready out of the box.",
        title: "Built on Cloudflare",
    },
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
        <div className="relative bg-background">
            <Section
                classes={{
                    childrenWrapper: "!grid-cols-1",
                    root: "min-h-screen !pt-24 !pb-12",
                }}
                gridLength={0}
                mode="dark"
            >
                <div className="grid w-full grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-10">
                    <p className="sr-only">
                        Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer experience.
                        Define a schema and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live
                        subscriptions, optimistic updates, and an offline queue — types sync from server to client automatically via codegen.
                    </p>

                    {/* left rail */}
                    <div className="flex flex-col gap-8 lg:col-span-4">
                        <motion.div {...fade(0.1)} className="flex flex-col gap-5">
                            <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-balance text-white sm:text-5xl">
                                Realtime backends, end-to-end typed{" "}
                                <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">
                                    on Cloudflare&apos;s edge.
                                </span>
                            </h1>
                            <p className="max-w-md text-base text-white/55">
                                Typed queries, live sync, optimistic updates, and offline — global by default on Cloudflare Workers &amp; Durable Objects.
                            </p>
                        </motion.div>

                        <motion.div {...fade(0.2)} className="flex flex-col gap-3">
                            <button
                                className="group flex w-fit items-center gap-3 rounded-none border-[0.75px] border-white/12 bg-white/[0.03] px-4 py-2.5 font-mono text-sm text-white/70 transition-colors hover:border-white/20 hover:text-white"
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

                        <motion.div {...fade(0.3)} className="mt-2 flex flex-col">
                            {features.map((feature, index) => {
                                const isActive = index === activeFeature;

                                return (
                                    <button
                                        className="border-t-[0.75px] border-white/[0.08] py-4 text-left"
                                        key={feature.title}
                                        onClick={() => {
                                            setActiveFeature(index);
                                        }}
                                        type="button"
                                    >
                                        <span className="flex items-center gap-3">
                                            <span
                                                className={cn(
                                                    "font-mono text-xs tabular-nums transition-colors",
                                                    isActive ? "text-sky-sapphire" : "text-white/25",
                                                )}
                                            >
                                                {String(index + 1).padStart(2, "0")}
                                            </span>
                                            <span
                                                className={cn(
                                                    "text-lg font-medium tracking-tight transition-colors",
                                                    isActive ? "text-white" : "text-white/45",
                                                )}
                                            >
                                                {feature.title}
                                            </span>
                                        </span>
                                        <AnimatePresence initial={false}>
                                            {isActive && (
                                                <motion.p
                                                    animate={{ height: "auto", opacity: 1 }}
                                                    className="overflow-hidden pt-2 pl-7 text-sm leading-snug text-white/50"
                                                    exit={{ height: 0, opacity: 0 }}
                                                    initial={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.25 }}
                                                >
                                                    {feature.description}
                                                </motion.p>
                                            )}
                                        </AnimatePresence>
                                    </button>
                                );
                            })}
                        </motion.div>
                    </div>

                    {/* demo */}
                    <motion.div {...fade(0.4)} className="lg:col-span-8">
                        <LunoraDemo focus={activeFeature} />
                    </motion.div>
                </div>
            </Section>
        </div>
    );
};

export default MainHero;
