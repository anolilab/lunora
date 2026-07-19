import type { runAgentLoop } from "../src/agent-loop";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentDefinition, AgentFunctionReference, AgentGenerate, AgentGenerateResult, AgentRunFunction } from "../src/types";

interface StoredMessage {
    content: string;
    messageKey: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    threadKey: string;
    toolCallId?: string;
    toolCalls?: { id: string; input: unknown; name: string }[];
    toolName?: string;
}

interface StoredThread {
    agent: string;
    error?: string;
    instanceId?: string;
    key: string;
    messageCount: number;
    status: string;
    title?: string;
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
 * In-memory double of the agent runtime functions (`agents:*`), dispatched by
 * `__lunoraRef` with the same idempotency semantics the component implements
 * (keyed appends, get-or-create threads, counter-allocated seq). Trimmed copy
 * of the one in `agent-loop.test.ts`.
 */
export const memoryRuntime = (): {
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
        }

        return undefined;
    };

    const handlers = new Map<string, (args?: Record<string, unknown>) => unknown>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, appendMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, ensureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, listMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, patchThread],
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
