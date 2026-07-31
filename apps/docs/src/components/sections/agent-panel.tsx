"use client";

import { Check, Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import posthog from "@/lib/posthog";
import { cn } from "@/lib/utils";

/**
 * The interactive hero block: a tabbed, line-numbered code panel (server /
 * client) beside a live, editable preview of what that code renders — framed
 * by a border-x box with rounded corner nodes. Aurora-tinted.
 */

const KEYWORD = /^(?:import|from|const|export|async|await|function|return|new|default)$/;
const STRING = /^["'`]/;
const PUNCT = /^[{}()[\].,;:=><!]+$/;
const SPLIT_WS = /(\s+)/;

const tokenTone = (segment: string): string => {
    if (KEYWORD.test(segment)) {
        return "text-royal-amethyst";
    }

    if (STRING.test(segment)) {
        return "text-crimson-energy/80";
    }

    if (PUNCT.test(segment)) {
        return "text-white/35";
    }

    return "text-white/75";
};

const CodeText: FC<{ line: string }> = ({ line }) => {
    if (!line.trim()) {
        return <span className="whitespace-pre"> </span>;
    }

    return (
        <span className="whitespace-pre">
            {line.split(SPLIT_WS).map((segment, index) => {
                if (!segment) {
                    return null;
                }

                return (
                    <span className={tokenTone(segment)} key={index}>
                        {segment}
                    </span>
                );
            })}
        </span>
    );
};

const Code: FC<{ lines: string[] }> = ({ lines }) => (
    <pre className="overflow-x-auto px-2 py-4 font-mono text-[13px] leading-[1.55]">
        <code>
            {lines.map((line, index) => (
                <div className="flex" key={index}>
                    <span className="mr-5 inline-block w-6 shrink-0 text-right text-white/25 select-none">{index + 1}</span>
                    <CodeText line={line} />
                </div>
            ))}
        </code>
    </pre>
);

const SERVER_CODE = [
    "import { mutation, query, v } from 'lunorash/server';",
    "",
    "export const list = query.query(",
    "  async ({ ctx }) => ctx.db.query('todos').collect(),",
    ");",
    "",
    "export const add = mutation",
    "  .input({ text: v.string() })",
    "  .mutation(async ({ ctx, args }) =>",
    "    ctx.db.insert('todos', { ...args, done: false }),",
    "  );",
    "",
    "export const toggle = mutation",
    "  .input({ id: v.id('todos'), done: v.boolean() })",
    "  .mutation(async ({ ctx, args }) =>",
    "    ctx.db.patch(args.id, { done: args.done }),",
    "  );",
];

type Tab = "client" | "server";
type Framework = "react" | "solid" | "svelte" | "vue";

const TABS: Tab[] = ["server", "client"];
const FRAMEWORKS: Framework[] = ["react", "vue", "svelte", "solid"];

const CLIENT_CODE: Record<Framework, string[]> = {
    react: [
        "import { useMutation, useQuery } from '@lunora/react';",
        "import { api } from './_generated/api';",
        "",
        "export function Todos() {",
        "  const todos = useQuery(api.todos.list);",
        "  const add = useMutation(api.todos.add);",
        "",
        "  return todos?.map((todo) => (",
        "    <li key={todo._id}>{todo.text}</li>",
        "  ));",
        "}",
    ],
    solid: [
        "import { useMutation, useQuery } from '@lunora/solid';",
        "import { api } from './_generated/api';",
        "import { For } from 'solid-js';",
        "",
        "export function Todos() {",
        "  const todos = useQuery(api.todos.list);",
        "  const add = useMutation(api.todos.add);",
        "",
        "  return (",
        "    <For each={todos()}>",
        "      {(todo) => <li>{todo.text}</li>}",
        "    </For>",
        "  );",
        "}",
    ],
    svelte: [
        "<script lang='ts'>",
        "  import { useMutation, useQuery } from '@lunora/svelte';",
        "  import { api } from './_generated/api';",
        "",
        "  const todos = useQuery(api.todos.list);",
        "  const add = useMutation(api.todos.add);",
        "</script>",
        "",
        "{#each $todos ?? [] as todo (todo._id)}",
        "  <li>{todo.text}</li>",
        "{/each}",
    ],
    vue: [
        "<script setup lang='ts'>",
        "import { useMutation, useQuery } from '@lunora/vue';",
        "import { api } from './_generated/api';",
        "",
        "const todos = useQuery(api.todos.list);",
        "const add = useMutation(api.todos.add);",
        "</script>",
        "",
        "<template>",
        "  <li v-for='todo in todos' :key='todo._id'>",
        "    {{ todo.text }}",
        "  </li>",
        "</template>",
    ],
};

interface Todo {
    creationTime: number;
    docId: string;
    done: boolean;
    fresh: boolean;
    id: number;
    text: string;
}

const makeDocumentId = (n: number): string => `k${((n + 3) * 48_271 + 7).toString(36).padStart(7, "0").slice(0, 9)}`;

// Fixed base epoch (≈ 2024-06-01) so seed rows render identically on server/client.
const BASE_TIME = 1_717_200_000_000;

// UTC-only formatting — deterministic across server and client (no locale/TZ drift).
const formatTime = (ms: number): string => {
    if (!Number.isFinite(ms)) {
        return "—";
    }

    const date = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");

    return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const SEED: Todo[] = [
    { creationTime: BASE_TIME, docId: makeDocumentId(1), done: false, fresh: false, id: 1, text: "Ship the launch post" },
    { creationTime: BASE_TIME + 3_600_000, docId: makeDocumentId(2), done: true, fresh: false, id: 2, text: "Review the pull request" },
    { creationTime: BASE_TIME + 7_200_000, docId: makeDocumentId(3), done: false, fresh: false, id: 3, text: "Walk the dog" },
];

const COLUMNS: { name: string; type: string }[] = [
    { name: "_id", type: "id" },
    { name: "_creationTime", type: "number" },
    { name: "text", type: "string" },
    { name: "done", type: "boolean" },
];

// Module-scope updater so the settle timeout doesn't nest callbacks too deeply.
const withFreshCleared = (todos: Todo[], id: number): Todo[] =>
    todos.map((todo) => {
        if (todo.id !== id) {
            return todo;
        }

        return { ...todo, fresh: false };
    });

const AgentPanel: FC = () => {
    const reduceMotion = useReducedMotion();
    const [tab, setTab] = useState<Tab>("server");
    const [framework, setFramework] = useState<Framework>("react");
    const [todos, setTodos] = useState<Todo[]>(SEED);
    const [value, setValue] = useState("");
    const nextId = useRef(SEED.length + 1);
    const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

    useEffect(
        () => () => {
            timeouts.current.forEach((handle) => {
                clearTimeout(handle);
            });
        },
        [],
    );

    // Clear a row's "fresh" flag after a beat so its highlight can fade out.
    const settle = (id: number) => {
        const handle = setTimeout(() => {
            setTodos((previous) => withFreshCleared(previous, id));
        }, 1300);

        timeouts.current.push(handle);
    };

    const lines = tab === "server" ? SERVER_CODE : CLIENT_CODE[framework];

    const addTodo = () => {
        const text = value.trim() || "New task";

        nextId.current += 1;
        const id = nextId.current;

        setTodos((previous) => [...previous, { creationTime: Date.now(), docId: makeDocumentId(id), done: false, fresh: true, id, text }].slice(-7));
        posthog.capture("todo_added");
        setValue("");
        settle(id);
    };

    const toggleTodo = (id: number) => {
        const todo = todos.find((item) => item.id === id);

        if (!todo) {
            return;
        }

        setTodos((previous) =>
            previous.map((item) => {
                if (item.id !== id) {
                    return item;
                }

                return { ...item, done: !item.done, fresh: true };
            }),
        );
        posthog.capture("todo_toggled", { completed: !todo.done });
        settle(id);
    };

    return (
        <div className="relative mx-auto w-full max-w-6xl px-5 lg:px-0">
            <div className="grid grid-cols-1 gap-4 md:h-[540px] md:grid-cols-[1.2fr_1fr]">
                {/* code — full height */}
                <div className="flex min-h-0 flex-col border border-white/10 lg:border-l-0">
                    <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10">
                        <div className="flex items-center gap-2 px-4">
                            <span className="size-3 rounded-full border border-white/10 bg-white/25" />
                            <span className="size-3 rounded-full border border-white/10 bg-white/25" />
                            <span className="size-3 rounded-full border border-white/10 bg-white/25" />
                        </div>
                        <div className="flex h-full items-center">
                            {TABS.map((name) => (
                                <button
                                    aria-pressed={tab === name}
                                    className={cn(
                                        "flex h-full w-[104px] items-center justify-center border-l border-white/10 text-xs font-medium capitalize transition-colors",
                                        tab === name ? "bg-white/[0.05] text-white" : "text-white/45 hover:text-white",
                                    )}
                                    key={name}
                                    onClick={() => {
                                        setTab(name);
                                    }}
                                    type="button"
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    </div>
                    {tab === "client" ? (
                        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-3">
                            {FRAMEWORKS.map((name) => (
                                <button
                                    aria-pressed={framework === name}
                                    className={cn(
                                        "px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                                        framework === name ? "bg-white/[0.06] text-white" : "text-white/40 hover:text-white",
                                    )}
                                    key={name}
                                    onClick={() => {
                                        setFramework(name);
                                    }}
                                    type="button"
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <div className="min-h-0 grow overflow-auto">
                        <Code lines={lines} />
                    </div>
                </div>

                {/* right — app over table */}
                <div className="flex min-h-0 flex-col gap-4">
                    {/* app */}
                    <div className="flex min-h-0 flex-[1.1] flex-col border border-white/10 lg:border-r-0">
                        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
                            <span className="font-mono text-xs tracking-wide text-white/45">app · todos</span>
                            <span className="flex items-center gap-1.5 font-mono text-[11px] text-sky-sapphire">
                                <span className="size-1.5 animate-pulse rounded-full bg-sky-sapphire" />
                                live
                            </span>
                        </div>
                        <div className="min-h-0 grow space-y-1 overflow-y-auto p-3">
                            {todos.map((todo) => (
                                <button
                                    className="flex w-full items-center gap-3 px-2 py-2 text-left transition-colors hover:bg-white/[0.03]"
                                    key={todo.id}
                                    onClick={() => {
                                        toggleTodo(todo.id);
                                    }}
                                    type="button"
                                >
                                    <span
                                        className={cn(
                                            "flex size-4 shrink-0 items-center justify-center border transition-colors",
                                            todo.done ? "border-emerald-400/60 bg-emerald-400/20" : "border-white/20",
                                        )}
                                    >
                                        {todo.done ? <Check className="size-3 text-emerald-400" /> : null}
                                    </span>
                                    <span className={cn("truncate text-sm", todo.done ? "text-white/30 line-through" : "text-white/75")}>{todo.text}</span>
                                </button>
                            ))}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 border-t border-white/10 p-2.5">
                            <input
                                className="min-w-0 flex-1 bg-white/[0.04] px-3 py-2 text-sm text-white/80 outline-none transition-colors placeholder:text-white/30 focus:bg-white/[0.06]"
                                onChange={(event) => {
                                    setValue(event.target.value);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        addTodo();
                                    }
                                }}
                                placeholder="Add a todo…"
                                value={value}
                            />
                            <button
                                className="inline-flex shrink-0 items-center gap-1.5 bg-white px-3 py-2 text-xs font-semibold text-black transition-colors hover:bg-white/90"
                                onClick={addTodo}
                                type="button"
                            >
                                <Plus className="size-3.5" />
                                Add
                            </button>
                        </div>
                    </div>

                    {/* table — mirrors the same data */}
                    <div className="flex min-h-0 flex-1 flex-col border border-white/10 lg:border-r-0">
                        <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-4">
                            <span className="flex items-center gap-2">
                                <span className="size-2 bg-crimson-energy/70" />
                                <span className="font-mono text-[11px] tracking-wide text-white/45">studio · todos</span>
                            </span>
                            <span className="font-mono text-[10px] text-white/30">{todos.length} docs</span>
                        </div>
                        <div className="min-h-0 grow overflow-auto">
                            <table className="w-full border-collapse text-left font-mono text-[12px]">
                                <thead className="sticky top-0 z-10 bg-[hsl(240_20%_5%)]">
                                    <tr className="text-white/40">
                                        <th className="w-8 border-r border-b border-white/[0.08] px-2 py-2 text-center font-normal text-white/25">#</th>
                                        {COLUMNS.map((column) => (
                                            <th className="border-r border-b border-white/[0.08] px-3 py-2 font-normal last:border-r-0" key={column.name}>
                                                {column.name} <span className="text-white/20">{column.type}</span>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {todos.map((todo, index) => (
                                        <motion.tr
                                            animate={{ backgroundColor: todo.fresh ? "hsl(186 84% 56% / 0.16)" : "hsl(186 84% 56% / 0)" }}
                                            className="text-white/55"
                                            initial={false}
                                            key={todo.id}
                                            transition={{ duration: reduceMotion ? 0 : 0.9, ease: "easeOut" }}
                                        >
                                            <td className="w-8 border-r border-b border-white/[0.05] px-2 py-1.5 text-center text-white/25">{index + 1}</td>
                                            <td className="border-r border-b border-white/[0.05] px-3 py-1.5 text-white/35">{todo.docId}</td>
                                            <td className="border-r border-b border-white/[0.05] px-3 py-1.5 text-white/30 tabular-nums">
                                                {formatTime(todo.creationTime)}
                                            </td>
                                            <td className="max-w-[8rem] truncate border-r border-b border-white/[0.05] px-3 py-1.5 text-sky-sapphire/70">
                                                &quot;{todo.text}&quot;
                                            </td>
                                            <td className={cn("border-b border-white/[0.05] px-3 py-1.5", todo.done ? "text-emerald-400/80" : "text-white/40")}>
                                                {String(todo.done)}
                                            </td>
                                        </motion.tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AgentPanel;
