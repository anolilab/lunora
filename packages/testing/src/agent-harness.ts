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
    AgentTokenDelta,
} from "@lunora/agent";
import { createAgentGenerate, createStreamGenerate, DEFAULT_AGENT_FUNCTION_PATHS, runAgentLoop } from "@lunora/agent";
import type { SecretValueHost } from "@lunora/platform";
import type { LanguageModel } from "ai";

import { createFakeSecretValues } from "./fake-secret-values";
import WaitRegistry from "./wait-registry";

/** How long a supplied value stays takeable: the agent's secret value lifetime (15 minutes). */
const SECRET_VALUE_TTL_MS = 15 * 60 * 1000;

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
     * and to derive the child-agent export keys a sub-agent tool targets.
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
     * against the agent's own tools. Override per run via `run(..., { script })`,
     * or replace it per run with a streamed `model` via `run(..., { model })`.
     */
    script?: AgentGenerateResult[];

    /**
     * The secret store the agent's `requestSecretTool` values live in, shared by
     * every run of this harness. Default: an in-memory store whose clock only moves
     * through its `advanceClock`.
     */
    secrets?: SecretValueHost;
}

/** Per-run overrides for {@link AgentHarness.run}. */
interface AgentRunOverrides {
    /** The workflow instance id for this run (default: an auto-incrementing `wf-N`). */
    instanceId?: string;

    /**
     * The model for THIS run, replacing the scripted decisions. Each turn runs
     * through the production seam over this model: `createStreamGenerate` (the
     * `streamText` path, so a recorded stream from `recordedModel` is consumed
     * part by part) with `onTokenDelta` as its live sink.
     */
    model?: LanguageModel;

    /**
     * Live token-delta sink for a `model` run — receives each text delta as the
     * recorded stream produces it. Ignored for scripted runs.
     */
    onTokenDelta?: (delta: AgentTokenDelta) => void;

    /** The model script for THIS run, replacing the harness default. */
    script?: AgentGenerateResult[];
}

interface AgentHarness {
    /**
     * Resolve once a run has reached the wait named `name` (e.g. `secret:call_1`),
     * so a test can act on the run at a known point instead of after a delay.
     */
    awaitWait: (name: string) => Promise<void>;

    /**
     * Decline the `requestSecretTool` call `toolCallId` on `threadKey` and wake its
     * wait, as the owner's decline does.
     */
    decline: (threadKey: string, toolCallId: string) => void;

    /** Deliver the event a run is waiting on. Delivered before the wait is reached, it is held for it. */
    deliver: (name: string, payload: unknown) => void;

    /**
     * Every function dispatch the loop has made through `ctx.run`, in order —
     * both the `agents:*` runtime calls and the tool/memory app dispatches. Use
     * it to assert a tool called the function you expected with the args you
     * expected.
     */
    readonly dispatches: ReadonlyArray<HarnessDispatch>;

    /** Fail a pending wait the way an elapsed host timeout does. */
    expire: (name: string) => void;

    /**
     * Every journal entry the runs have written, in order: each memoized step
     * output (`{ kind: "step", name, output }`) and each delivered wait payload
     * (`{ kind: "wait", name, type, payload }`). A test asserts a secret is absent
     * from this, as it must be from the durable journal.
     */
    journalEntries: () => unknown[];

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

    /** The secret store the runs use (see {@link AgentHarnessOptions.secrets}). */
    readonly secrets: SecretValueHost;

    /**
     * Supply `value` for the `requestSecretTool` call `toolCallId` on `threadKey` and
     * wake its wait, as the owner's supply does. The value goes to the secret store
     * and only the request's handle reaches the run.
     */
    supply: (threadKey: string, toolCallId: string, value: string) => Promise<void>;

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
 * the same instance. A `waitForEvent` hibernates until the test delivers its
 * event or expires it (see {@link AgentHarness.deliver}).
 */
class DurableStepJournal implements AgentStepLike {
    public readonly invoked: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public constructor(private readonly waits: WaitRegistry) {}

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

    public async waitForEvent<T>(name: string, options: { timeout?: number | string; type: string }): Promise<{ payload: Readonly<T>; type: string }> {
        const payload = await this.waits.wait(name, options.type);

        return { payload: payload as Readonly<T>, type: options.type };
    }

    /** The memoized step outputs, as the durable journal persists them. */
    public steps(): { kind: "step"; name: string; output: unknown }[] {
        return [...this.entries].map(([name, entry]) => {
            return { kind: "step" as const, name, output: entry.output };
        });
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
    secrets: SecretValueHost,
): {
    declineSecret: (threadKey: string, toolCallId: string) => void;
    dispatches: HarnessDispatch[];
    messages: Map<string, HarnessMessage>;
    run: AgentRunFunction;
    supplySecret: (threadKey: string, toolCallId: string, value: string) => Promise<void>;
    threads: Map<string, HarnessThread>;
} => {
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

            return { outcome: "continued" };
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

        return { outcome: "created" };
    };

    // The loop retires an approval or secret marker by key once its wait has resolved.
    const deleteMessage = (args?: Record<string, unknown>): unknown => {
        messages.delete(`${args?.["threadKey"] as string}:${args?.["messageKey"] as string}`);

        return undefined;
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

    /**
     * The run-completion mutation: terminal status plus, in production, the
     * hand-off to the next queued run. The harness keeps no run queue — a test
     * drives one run at a time — so it applies the terminal patch and reports an
     * empty queue, including the ownership guard that makes a replayed
     * completion a no-op.
     */
    const completeRun = (args?: Record<string, unknown>): unknown => {
        const thread = threads.get(args?.["key"] as string);

        if (!args || !thread || thread.instanceId !== args["instanceId"]) {
            return {};
        }

        for (const [field, value] of Object.entries(args)) {
            if (field !== "key" && field !== "instanceId" && value !== undefined) {
                (thread as unknown as Record<string, unknown>)[field] = value;
            }
        }

        return {};
    };

    // The secret-request rows, one per `(threadKey, toolCallId)`. The harness has no
    // database, so the transitions below restate the component's: a pending row settles
    // once, a supply binds its ref, and a take must name the consumer the request declared.
    // The component's own tests pin each transition against the real mutations.
    const requests = new Map<
        string,
        { consumerTool: string; instanceId: string; ref?: string; status: "consumed" | "declined" | "expired" | "pending" | "supplied" }
    >();
    const requestOf = (args?: Record<string, unknown>) => requests.get(`${args?.["threadKey"] as string}:${args?.["toolCallId"] as string}`);

    // A replay of the owning run keeps its row. A row left by an earlier run that reused the
    // tool-call id is retired first, which discards its value, and then starts over as pending.
    const openSecretRequest = async (args?: Record<string, unknown>): Promise<unknown> => {
        const key = `${args?.["threadKey"] as string}:${args?.["toolCallId"] as string}`;
        const existing = requests.get(key);

        const owner = args?.["instanceId"] as string | undefined;

        if (owner !== undefined && existing?.instanceId === owner) {
            return undefined;
        }

        if (existing?.ref !== undefined) {
            await secrets.discard(existing.ref);
        }

        requests.set(key, { consumerTool: args?.["consumerTool"] as string, instanceId: args?.["instanceId"] as string, status: "pending" });

        return undefined;
    };

    const settleSecretRequest = (args?: Record<string, unknown>): { status: "declined" | "expired" | "supplied" } => {
        const request = requestOf(args);

        if (request === undefined) {
            return { status: "expired" };
        }

        if (request.status === "pending") {
            request.status = "expired";

            return { status: "expired" };
        }

        if (request.status === "supplied" || request.status === "consumed") {
            return { status: "supplied" };
        }

        return { status: request.status === "declined" ? "declined" : "expired" };
    };

    const takeSecret = (args?: Record<string, unknown>): Promise<unknown> => {
        const request = requestOf(args);

        if (request?.ref === undefined || (request.status !== "supplied" && request.status !== "consumed")) {
            return Promise.resolve(undefined);
        }

        if (args?.["claimant"] !== `tool:${request.consumerTool}:${args?.["consumerCallId"] as string}`) {
            return Promise.resolve(undefined);
        }

        return secrets.take(request.ref, { claimant: args["claimant"], scope: args["threadKey"] as string });
    };

    const discardSecret = async (args?: Record<string, unknown>): Promise<void> => {
        const request = requestOf(args);

        if (request === undefined) {
            return;
        }

        if (request.ref !== undefined) {
            await secrets.discard(request.ref);
        }

        if (request.status === "supplied") {
            request.status = "consumed";
        }
    };

    const supplySecret = async (threadKey: string, toolCallId: string, value: string): Promise<void> => {
        const request = requests.get(`${threadKey}:${toolCallId}`);

        if (request?.status !== "pending") {
            throw new Error(`agentHarness: no pending secret request for tool call "${toolCallId}" on thread "${threadKey}"`);
        }

        // The value lives as long as the agent's supply window; a take after it refuses.
        request.ref = await secrets.put(value, { scope: threadKey, ttlMs: SECRET_VALUE_TTL_MS });
        request.status = "supplied";
    };

    const declineSecret = (threadKey: string, toolCallId: string): void => {
        const request = requests.get(`${threadKey}:${toolCallId}`);

        if (request?.status === "pending") {
            request.status = "declined";
        }
    };

    const handlers = new Map<string, HarnessFunction>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, appendMessage],
        // No approval grants are recorded by this harness: a gated tool always
        // pauses, exactly as an ungranted one does against the real component.
        [DEFAULT_AGENT_FUNCTION_PATHS.approvalGranted, () => false],
        [DEFAULT_AGENT_FUNCTION_PATHS.completeRun, completeRun],
        [DEFAULT_AGENT_FUNCTION_PATHS.deleteMessage, deleteMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.discardSecret, discardSecret],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, ensureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, listMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.openSecretRequest, openSecretRequest],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, patchThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.settleSecretRequest, settleSecretRequest],
        [DEFAULT_AGENT_FUNCTION_PATHS.takeSecret, takeSecret],
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

    return { declineSecret, dispatches, messages, run, supplySecret, threads };
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
 * The harness deliberately does NOT model the concurrency guard. A
 * human-in-the-loop pause (an approval, or a `requestSecretTool` request) stops
 * the run at its wait; the test resolves it with `deliver` or `expire`, and the
 * harness does not route a decision through the owner-gated mutations. The
 * harness is for exercising an agent's tools and turn logic, not the durable
 * orchestration itself (that is covered inside `@lunora/agent`).
 */
const agentHarness = (agent: AgentDefinition, options: AgentHarnessOptions): AgentHarness => {
    const exportName = options.exportName ?? "agent";
    const env = options.env ?? { LUNORA_TEST: true };
    const secrets = options.secrets ?? createFakeSecretValues();
    const runtime = createRuntime(options.functions ?? {}, secrets);
    const waits = new WaitRegistry();
    const journals: DurableStepJournal[] = [];

    const newJournal = (): DurableStepJournal => {
        const journal = new DurableStepJournal(waits);

        journals.push(journal);

        return journal;
    };

    let runCount = 0;

    const run = (params: AgentRunInput, overrides?: AgentRunOverrides): Promise<AgentRunResult> => {
        runCount += 1;

        const instanceId = overrides?.instanceId ?? `wf-${String(runCount)}`;
        const { model, onTokenDelta } = overrides ?? {};

        if (model !== undefined) {
            // The production seams over a model: `agent.model` is the only thing the
            // seams read from the definition, so the spread just swaps that one field.
            const modelAgent = { ...agent, model };

            return runAgentLoop({
                agent,
                env,
                exportName,
                generate: createAgentGenerate(modelAgent, env),
                instanceId,
                onTokenDelta: (event) => {
                    // The loop's token sink also carries progress events; the harness surfaces tokens only.
                    if (event.kind !== "progress") {
                        onTokenDelta?.(event);
                    }
                },
                params,
                paths: DEFAULT_AGENT_FUNCTION_PATHS,
                run: runtime.run,
                step: newJournal(),
                streamGenerate: createStreamGenerate(modelAgent, env),
            });
        }

        const script = overrides?.script ?? options.script ?? [];

        return runAgentLoop({
            agent,
            env,
            exportName,
            generate: scriptedGenerate(script),
            instanceId,
            params,
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run: runtime.run,
            step: newJournal(),
        });
    };

    return {
        awaitWait: (name: string) => waits.awaitWait(name),
        deliver: (name: string, payload: unknown) => {
            waits.deliver(name, payload);
        },
        decline: (threadKey: string, toolCallId: string) => {
            runtime.declineSecret(threadKey, toolCallId);
            waits.deliver(`secret:${toolCallId}`, {});
        },
        dispatches: runtime.dispatches,
        expire: (name: string) => {
            waits.expire(name);
        },
        journalEntries: (): unknown[] => [
            ...journals.flatMap((journal) => journal.steps()),
            ...waits.records.map((record) => {
                return { kind: "wait", ...record };
            }),
        ],
        messages: (threadKey: string): AgentMessageRow[] =>
            [...runtime.messages.values()]
                .filter((message) => message.threadKey === threadKey)
                .toSorted((a, b) => a.seq - b.seq)
                .map(({ messageKey: _messageKey, threadKey: _threadKey, ...row }) => row),
        run,
        secrets,
        supply: async (threadKey: string, toolCallId: string, value: string) => {
            await runtime.supplySecret(threadKey, toolCallId, value);
            waits.deliver(`secret:${toolCallId}`, {});
        },
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
