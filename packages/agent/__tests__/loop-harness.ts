import type { runAgentLoop } from "../src/agent-loop";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentDefinition, AgentFunctionReference, AgentGenerate, AgentGenerateResult, AgentRunFunction, AgentStepLike } from "../src/types";

export interface StoredMessage {
    content: string;
    messageKey: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    status?: "approved" | "awaiting_approval" | "rejected";
    stepName?: string;
    threadKey: string;
    toolCallId?: string;
    toolCalls?: { id: string; input: unknown; name: string }[];
    toolName?: string;
}

export interface StoredThread {
    agent: string;
    error?: string;
    instanceId?: string;
    key: string;
    messageCount: number;
    status: string;
    title?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Faithful in-memory model of Cloudflare Workflows' `step.do` memoization,
 * shared by the tools-ecosystem suites (mirrors the one in
 * `agent-loop.test.ts`): a step name with a recorded output returns it WITHOUT
 * re-invoking the callback, so reusing a journal across two `runAgentLoop`
 * calls models a crash + resume of the same instance.
 */
export class DurableStepJournal {
    public readonly invoked: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            return existing.output as T;
        }

        this.invoked.push(name);

        const output = await callback();

        this.entries.set(name, { output });

        return output;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, class-methods-use-this -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
    public async waitForEvent<T>(_name: string, _options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> {
        // These suites never gate a tool on approval; hibernate forever if reached.
        return new Promise<{ payload: T; type: string }>(() => {});
    }
}

/**
 * A pass-through {@link AgentStepLike} for suites that drive a tool's `execute`
 * (or `runToolScript`) directly, outside the loop: `do` just runs the callback,
 * with no memoization and no journal. `AgentToolContext.step` is REQUIRED —
 * production always threads a real handle — so a hand-built context supplies
 * this instead of omitting the field.
 */
export const passthroughStep: AgentStepLike = {
    do: <T>(_name: string, callback: () => Promise<T>): Promise<T> => callback(),

    // Mirrors AgentStepLike.waitForEvent's generic host signature so the double stays assignable.
    waitForEvent: <T>(): Promise<{ payload: Readonly<T>; type: string }> =>
        // These suites never gate a tool on approval; hibernate forever if reached.
        new Promise<{ payload: Readonly<T>; type: string }>(() => {}),
};

/**
 * In-memory double of the agent runtime functions (`agents:*`), dispatched by
 * `__lunoraRef` with the same idempotency semantics the component implements
 * (keyed appends, get-or-create threads, counter-allocated seq).
 *
 * ONE copy for every suite that drives the loop — `agent-loop`, `skill`, and any
 * future one. Three near-identical copies used to exist, so adding a single
 * runtime function (the run-completion mutation) meant patching the same handler
 * three times and missing it in a fourth place entirely.
 */
export const memoryRuntime = (options?: {
    /** Extra `path → handler` dispatch entries (e.g. an agentic `read` action). */
    handlers?: Record<string, (args?: Record<string, unknown>) => unknown>;
    /** The memory action's `result` — a fixed value, or a fn of the dispatch args (per-query results). */
    memory?: { path: string; result: Record<string, unknown> | ((args?: Record<string, unknown>) => unknown) };
}): {
    dispatches: { args: Record<string, unknown> | undefined; path: string }[];
    messages: Map<string, StoredMessage>;
    run: AgentRunFunction;
    threads: Map<string, StoredThread>;
} => {
    const threads = new Map<string, StoredThread>();
    const messages = new Map<string, StoredMessage>();
    const dispatches: { args: Record<string, unknown> | undefined; path: string }[] = [];

    const ensureThread = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;
        const instanceId = args?.["instanceId"] as string | undefined;
        const existing = threads.get(key);

        if (existing) {
            // Mirror the real component's concurrency guard: a running thread
            // owned by a DIFFERENT instance is a genuine second run.
            const isConcurrentRun =
                existing.status === "running" && existing.instanceId !== undefined && instanceId !== undefined && existing.instanceId !== instanceId;

            if (isConcurrentRun) {
                const policy = (args?.["onConcurrentRun"] as string | undefined) ?? "reject";
                const priorInstanceId = existing.instanceId ?? "";

                if (policy !== "replace") {
                    throw new Error(`@lunora/agent: thread "${key}" already has a run in flight (instance "${priorInstanceId}") — onConcurrentRun="${policy}"`);
                }

                existing.status = "running";
                existing.instanceId = instanceId;
                delete existing.error;

                return { outcome: "replaced", priorInstanceId };
            }

            existing.status = "running";
            delete existing.error;

            if (instanceId !== undefined) {
                existing.instanceId = instanceId;
            }

            return { outcome: "continued" };
        }

        threads.set(key, {
            agent: args?.["agent"] as string,
            instanceId,
            key,
            messageCount: 0,
            status: "running",
            title: args?.["title"] as string | undefined,
        });

        return { outcome: "created" };
    };

    const appendMessage = (args?: Record<string, unknown>): unknown => {
        const threadKey = args?.["threadKey"] as string;
        const messageKey = args?.["messageKey"] as string;
        const id = `${threadKey}:${messageKey}`;
        const existing = messages.get(id);

        if (existing) {
            return { seq: existing.seq };
        }

        const thread = threads.get(threadKey);

        if (!thread) {
            throw new Error(`unknown thread ${threadKey}`);
        }

        const seq = thread.messageCount;

        thread.messageCount += 1;
        messages.set(id, { ...(args as unknown as StoredMessage), seq });

        return { seq };
    };

    const listMessages = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;

        return [...messages.values()].filter((message) => message.threadKey === key).toSorted((a, b) => a.seq - b.seq);
    };

    const patchThread = (args?: Record<string, unknown>): unknown => {
        const thread = threads.get(args?.["key"] as string);

        if (thread) {
            if (args?.["status"] !== undefined) {
                thread.status = args["status"] as string;
            }

            if (args?.["error"] !== undefined) {
                thread.error = args["error"] as string;
            }

            if (args?.["usage"] !== undefined) {
                thread.usage = args["usage"] as StoredThread["usage"];
            }
        }

        return undefined;
    };

    /**
     * The completion mutation: terminal patch + queue handoff. This double keeps
     * no queue (see `run-queue.test.ts` for those semantics), so it ends the run
     * exactly as the real one does with an empty queue — including the ownership
     * guard that makes a replayed completion a no-op.
     */
    const completeRun = (args?: Record<string, unknown>): unknown => {
        const thread = threads.get(args?.["key"] as string);

        if (!args || !thread || thread.instanceId !== args["instanceId"]) {
            return {};
        }

        thread.status = args["status"] as string;

        if (args["error"] !== undefined) {
            thread.error = args["error"] as string;
        }

        if (args["usage"] !== undefined) {
            thread.usage = args["usage"] as StoredThread["usage"];
        }

        return {};
    };

    const memoryHandler = (args?: Record<string, unknown>): unknown => {
        const result = options?.memory?.result;

        return typeof result === "function" ? result(args) : result;
    };

    const handlers = new Map<string, (args?: Record<string, unknown>) => unknown>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, appendMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.completeRun, completeRun],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, ensureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, listMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, patchThread],
        ...(options?.memory ? ([[options.memory.path, memoryHandler]] as const) : []),
        ...Object.entries(options?.handlers ?? {}),
    ]);

    const run: AgentRunFunction = async (reference: AgentFunctionReference, args?: Record<string, unknown>) => {
        const path = reference["__lunoraRef"];

        dispatches.push({ args, path });

        const handler = handlers.get(path);

        if (!handler) {
            throw new Error(`unexpected dispatch: ${path}`);
        }

        return handler(args);
    };

    return { dispatches, messages, run, threads };
};

/** A scripted LLM: pops one decision per turn. */
export const scriptedGenerate = (script: AgentGenerateResult[]): AgentGenerate => {
    const remaining = [...script];

    return async () => {
        const next = remaining.shift();

        if (!next) {
            throw new Error("scripted generate exhausted");
        }

        return next;
    };
};

/** A terminal (final-answer) turn. */
export const finalTurn = (text: string): AgentGenerateResult => {
    return { text, toolCalls: [] };
};

/** A single-tool-call turn. */
export const toolTurn = (id: string, name: string, input: unknown, text = ""): AgentGenerateResult => {
    return { text, toolCalls: [{ id, input, name }] };
};

/** Default `runAgentLoop` options with the harness runtime, overridable per test. */
export const loopDefaults = (agent: AgentDefinition, overrides?: Partial<Parameters<typeof runAgentLoop>[0]>): Parameters<typeof runAgentLoop>[0] => {
    return {
        agent,
        env: { LUNORA_TEST: true },
        exportName: "support",
        generate: scriptedGenerate([finalTurn("hi")]),
        instanceId: "wf-1",
        params: { input: "hello", threadKey: "thread-1" },
        paths: DEFAULT_AGENT_FUNCTION_PATHS,
        run: memoryRuntime().run,
        step: new DurableStepJournal(),
        ...overrides,
    };
};

/**
 * A minimal in-memory `ctx.db` for suites that drive the REAL component
 * mutations rather than a dispatch double — `withIndex` filters by the declared
 * equalities, and insertion order stands in for index order.
 *
 * Shared because two suites had byte-identical copies of it.
 */
export interface FakeRow extends Record<string, unknown> {
    _id: string;
}

/** Collect the `.eq(...)` conditions a `withIndex` callback declares. */
export const collectConditions = (build: (q: unknown) => unknown): [string, unknown][] => {
    const conditions: [string, unknown][] = [];
    const builder = {
        eq: (field: string, value: unknown) => {
            conditions.push([field, value]);

            return builder;
        },
    };

    build(builder);

    return conditions;
};

/** Filter by the `.eq(...)` conditions; insertion order stands in for index order. */
export const makeIndexQuery = (
    candidates: FakeRow[],
    build: (q: unknown) => unknown,
): { collect: () => Promise<FakeRow[]>; first: () => Promise<FakeRow | null> } => {
    const conditions = collectConditions(build);
    const matches = (): FakeRow[] => candidates.filter((row) => conditions.every(([field, value]) => row[field] === value));

    return {
        collect: async () => matches(),
        first: async () => matches()[0] ?? null,
    };
};

/**
 * An in-memory `ctx.db`. `withIndex` filters by the declared equalities and — as
 * the real index read does — returns rows in insertion order, which for the
 * `(threadKey, position)` index is position order.
 */
export const fakeDatabase = (): { database: Record<string, unknown>; rows: Map<string, FakeRow[]> } => {
    const rows = new Map<string, FakeRow[]>();
    let nextId = 0;

    const tableRows = (table: string): FakeRow[] => {
        const existing = rows.get(table);

        if (existing) {
            return existing;
        }

        const created: FakeRow[] = [];

        rows.set(table, created);

        return created;
    };

    const database = {
        delete: async (id: string) => {
            for (const [table, tableContent] of rows) {
                rows.set(
                    table,
                    tableContent.filter((row) => row["_id"] !== id),
                );
            }
        },
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `id-${String(nextId)}`;

            nextId += 1;
            tableRows(table).push({ ...document, _id: id });

            return id;
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            for (const tableContent of rows.values()) {
                const row = tableContent.find((candidate) => candidate["_id"] === id);

                if (row) {
                    for (const [key, value] of Object.entries(patch)) {
                        if (value === undefined) {
                            Reflect.deleteProperty(row, key);
                        } else {
                            row[key] = value;
                        }
                    }
                }
            }
        },
        query: (table: string) => {
            return {
                withIndex: (_name: string, build: (q: unknown) => unknown) => makeIndexQuery(tableRows(table), build),
            };
        },
    };

    return { database, rows };
};
