import type {
    AgentDefinition,
    AgentFunctionReference,
    AgentGenerate,
    AgentGenerateResult,
    AgentMessageRow,
    AgentRunFunction,
    AgentRunInput,
    AgentRunResult,
    AgentStepLike,
} from "@lunora/agent";
import { DEFAULT_AGENT_FUNCTION_PATHS, runAgentLoop } from "@lunora/agent";

/** A thread message as the in-memory runtime stores it (superset of {@link AgentMessageRow}). */
interface HarnessMessage extends AgentMessageRow {
    messageKey: string;
    threadKey: string;
}

/** A thread record as the in-memory runtime stores it. */
interface HarnessThread {
    agent: string;
    error?: string;
    instanceId?: string;
    key: string;
    messageCount: number;
    owner?: string;
    status: string;
    title?: string;
    usage?: unknown;
}

/** One recorded function dispatch the loop made through `ctx.run`. */
interface HarnessDispatch {
    args: Record<string, unknown> | undefined;
    path: string;
}

/** Extra function-dispatch handler layered over the built-in `agents:*` runtime double. */
type HarnessFunction = (args?: Record<string, unknown>) => unknown;

interface AgentHarnessOptions {
    /**
     * Worker `env` bindings visible to tool `execute` and a dynamic
     * `instructions` thunk. Default `{ LUNORA_TEST: true }`.
     */
    env?: Record<string, unknown>;

    /**
     * The agent's `lunora/agents.ts` export name — used for thread attribution
     * and to derive the child-agent `AGENT_*` bindings a sub-agent tool targets.
     * Default `"agent"`.
     */
    exportName?: string;

    /**
     * Stub the app functions a tool's `execute` (or the agent's `memory.source`)
     * dispatches through `ctx.run`, keyed by function path (`"weather:lookup"`).
     * A handler layered here shadows the built-in `agents:*` runtime double for
     * that path. An unstubbed non-`agents:*` dispatch throws, so a missing stub
     * fails loudly rather than silently returning `undefined`.
     */
    functions?: Record<string, HarnessFunction>;

    /**
     * Scripted model decisions, one {@link AgentGenerateResult} per LLM turn —
     * the default script for {@link AgentHarness.run}. A terminal turn has an
     * empty `toolCalls`; a tool-calling turn lists the calls the loop then runs
     * against the agent's own tools. Override per run via `run(..., { script })`.
     */
    script: AgentGenerateResult[];
}

/** Per-run overrides for {@link AgentHarness.run}. */
interface AgentRunOverrides {
    /** The workflow instance id for this run (default: an auto-incrementing `wf-N`). */
    instanceId?: string;

    /** The model script for THIS run, replacing the harness default. */
    script?: AgentGenerateResult[];
}

interface AgentHarness {
    /**
     * Every function dispatch the loop has made through `ctx.run`, in order —
     * both the `agents:*` runtime calls and the tool/memory app dispatches. Use
     * it to assert a tool called the function you expected with the args you
     * expected.
     */
    readonly dispatches: ReadonlyArray<HarnessDispatch>;

    /** The persisted messages of a thread, ordered by `seq`. */
    messages: (threadKey: string) => AgentMessageRow[];

    /**
     * Drive one durable agent run to completion against the in-memory journal +
     * runtime double, returning the loop's {@link AgentRunResult}. Reuse the same
     * `threadKey` across calls to continue a conversation (the persisted history
     * carries over); each call runs under a fresh instance id, modelling a
     * distinct workflow instance.
     */
    run: (params: AgentRunInput, overrides?: AgentRunOverrides) => Promise<AgentRunResult>;

    /** The stored thread record (status, error, instanceId, usage, …), or `undefined` before its first run. */
    thread: (threadKey: string) => HarnessThread | undefined;
}

/**
 * A scripted LLM: pops one decision per turn off the queue. Ignores the assembled
 * messages — the point of the harness is to make the model deterministic.
 */
const scriptedGenerate = (script: ReadonlyArray<AgentGenerateResult>): AgentGenerate => {
    const remaining = [...script];

    return () => {
        const next = remaining.shift();

        if (!next) {
            throw new Error("agentHarness: scripted generate exhausted — the run took more turns than the script provided.");
        }

        return Promise.resolve(next);
    };
};

/**
 * Faithful in-memory model of Cloudflare Workflows' `step.do` memoization: a step
 * name with a recorded output returns it WITHOUT re-invoking the callback, so
 * reusing a journal across two `runAgentLoop` calls models a crash + resume of
 * the same instance. `waitForEvent` hibernates forever — the harness is for the
 * ordinary tool-loop, not human-in-the-loop approval pauses (those need a real
 * `sendEvent`, out of scope for a single synchronous drive).
 */
class DurableStepJournal implements AgentStepLike {
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

    // eslint-disable-next-line class-methods-use-this -- mirrors AgentStepLike.waitForEvent's host signature so the mock stays assignable
    public async waitForEvent<T>(_name: string, _options: { timeout?: number | string; type: string }): Promise<{ payload: Readonly<T>; type: string }> {
        return new Promise<{ payload: Readonly<T>; type: string }>(() => {});
    }
}

/**
 * In-memory double of the agent runtime functions (`agents:*`), dispatched by
 * `__lunoraRef` with the same idempotency semantics the real component
 * implements: keyed appends, get-or-create threads, counter-allocated `seq`.
 * Extra `functions` are layered over it so a tool's own `ctx.run(appFn, …)`
 * dispatches resolve too.
 */
const createRuntime = (
    extra: Record<string, HarnessFunction>,
): { dispatches: HarnessDispatch[]; messages: Map<string, HarnessMessage>; run: AgentRunFunction; threads: Map<string, HarnessThread> } => {
    const threads = new Map<string, HarnessThread>();
    const messages = new Map<string, HarnessMessage>();
    const dispatches: HarnessDispatch[] = [];

    const ensureThread = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;
        const instanceId = args?.["instanceId"] as string | undefined;
        const existing = threads.get(key);

        if (existing) {
            existing.status = "running";
            delete existing.error;

            if (instanceId !== undefined) {
                existing.instanceId = instanceId;
            }

            return { created: false };
        }

        threads.set(key, {
            agent: args?.["agent"] as string,
            instanceId,
            key,
            messageCount: 0,
            owner: args?.["owner"] as string | undefined,
            status: "running",
            title: args?.["title"] as string | undefined,
        });

        return { created: true };
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
            throw new Error(`agentHarness: append to unknown thread "${threadKey}".`);
        }

        const seq = thread.messageCount;

        thread.messageCount += 1;
        messages.set(id, { ...(args as unknown as HarnessMessage), seq });

        return { seq };
    };

    const listMessages = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;

        return [...messages.values()].filter((message) => message.threadKey === key).toSorted((a, b) => a.seq - b.seq);
    };

    const patchThread = (args?: Record<string, unknown>): unknown => {
        const thread = threads.get(args?.["key"] as string);

        if (thread) {
            // Copy every patched field except the addressing `key` onto the record
            // (status, error, usage, …) — generic so new patch fields surface.
            for (const [field, value] of Object.entries(args ?? {})) {
                if (field !== "key" && value !== undefined) {
                    (thread as unknown as Record<string, unknown>)[field] = value;
                }
            }
        }

        return undefined;
    };

    const handlers = new Map<string, HarnessFunction>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, appendMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, ensureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, listMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, patchThread],
        ...Object.entries(extra),
    ]);

    const run: AgentRunFunction = (reference: AgentFunctionReference, args?: Record<string, unknown>) => {
        const path = reference["__lunoraRef"];

        dispatches.push({ args, path });

        const handler = handlers.get(path);

        if (!handler) {
            throw new Error(`agentHarness: unstubbed dispatch "${path}" — pass a \`functions\` handler for it.`);
        }

        return Promise.resolve(handler(args));
    };

    return { dispatches, messages, run, threads };
};

/**
 * A unit-test harness for a `defineAgent` tool-loop that runs WITHOUT a real
 * model or network. It drives {@link runAgentLoop} over the agent's own
 * `AgentGenerate` seam — the model is a script of per-turn decisions, tool calls
 * run the agent's real `execute` functions inside an in-memory durable-step
 * journal, and thread/message persistence goes through an in-memory `agents:*`
 * runtime double. Mock any function a tool (or the agent's memory) dispatches
 * through the `functions` option.
 *
 * ```ts
 * const harness = agentHarness(support, {
 *     script: [toolCallTurn("c1", "lookup", { id: "o_1" }), finalTurn("It shipped.")],
 *     functions: { "orders:lookup": () => ({ status: "shipped" }) },
 * });
 * const result = await harness.run({ input: "where is my order?", threadKey: "t1" });
 * expect(result.text).toBe("It shipped.");
 * expect(harness.messages("t1").at(-1)?.content).toBe("It shipped.");
 * ```
 *
 * The harness deliberately does NOT model the concurrency guard or a
 * human-in-the-loop approval pause — it is for exercising an agent's tools and
 * turn logic, not the durable orchestration itself (that is covered inside
 * `@lunora/agent`).
 */
const agentHarness = (agent: AgentDefinition, options: AgentHarnessOptions): AgentHarness => {
    const exportName = options.exportName ?? "agent";
    const env = options.env ?? { LUNORA_TEST: true };
    const runtime = createRuntime(options.functions ?? {});

    let runCount = 0;

    const run = (params: AgentRunInput, overrides?: AgentRunOverrides): Promise<AgentRunResult> => {
        runCount += 1;

        const instanceId = overrides?.instanceId ?? `wf-${String(runCount)}`;
        const script = overrides?.script ?? options.script;

        return runAgentLoop({
            agent,
            env,
            exportName,
            generate: scriptedGenerate(script),
            instanceId,
            params,
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run: runtime.run,
            step: new DurableStepJournal(),
        });
    };

    return {
        dispatches: runtime.dispatches,
        messages: (threadKey: string): AgentMessageRow[] =>
            [...runtime.messages.values()]
                .filter((message) => message.threadKey === threadKey)
                .toSorted((a, b) => a.seq - b.seq)
                .map(({ messageKey: _messageKey, threadKey: _threadKey, ...row }) => row),
        run,
        thread: (threadKey: string): HarnessThread | undefined => runtime.threads.get(threadKey),
    };
};

/** A terminal (final-answer) turn — no tool calls. */
const finalTurn = (text: string, extra?: Partial<AgentGenerateResult>): AgentGenerateResult => {
    return { text, toolCalls: [], ...extra };
};

/** A single-tool-call turn: the loop runs the named tool with `input`. */
const toolCallTurn = (id: string, name: string, input: unknown, text = ""): AgentGenerateResult => {
    return { text, toolCalls: [{ id, input, name }] };
};

export type { AgentHarness, AgentHarnessOptions, AgentRunOverrides, HarnessDispatch, HarnessMessage, HarnessThread };
export { agentHarness, finalTurn, toolCallTurn };
