import { buildModelMessages } from "./model-messages";
import { toFunctionReference } from "./paths";
import type {
    AgentDefinition,
    AgentFunctionPaths,
    AgentGenerate,
    AgentMessageRow,
    AgentRunFunction,
    AgentRunInput,
    AgentRunResult,
    AgentStepLike,
    AgentToolCall,
    AnyAgentTool,
} from "./types";

interface AgentLoopOptions {
    agent: AgentDefinition;
    env: Record<string, unknown>;
    /** The agent's `lunora/agents.ts` export name (thread attribution). */
    exportName: string;
    /** The LLM-turn seam — production wires AI SDK `generateText`. */
    generate: AgentGenerate;
    /** The workflow instance id — the deterministic per-run message-key prefix. */
    instanceId: string;
    params: AgentRunInput;
    paths: AgentFunctionPaths;
    run: AgentRunFunction;
    step: AgentStepLike;
}

const DEFAULT_MAX_TURNS = 8;

/** Everything one turn (and its tool calls) needs, prepared once per run. */
interface TurnContext {
    agent: AgentDefinition;
    env: Record<string, unknown>;
    generate: AgentGenerate;
    instanceId: string;
    listMessages: ReturnType<typeof toFunctionReference>;
    memoryContext: string | undefined;
    persist: (message: Record<string, unknown>) => Promise<void>;
    run: AgentRunFunction;
    step: AgentStepLike;
    threadKey: string;
    tools: Record<string, AnyAgentTool>;
}

/** JSON-encode a tool's non-string output; `undefined` encodes as "null". */
const stringifyOutput = (output: unknown): string => (output === undefined ? "null" : JSON.stringify(output));

const runToolCall = async (turnContext: TurnContext, call: AgentToolCall): Promise<void> => {
    const { env, instanceId, persist, run, step, threadKey, tools } = turnContext;
    const stepName = `tool:${call.name}:${call.id}`;
    const tool: AnyAgentTool | undefined = tools[call.name];

    // The model can only call declared tools (the schema constrains it), but a
    // hallucinated name must not crash the run — record it as a failed result
    // so the next turn lets the model recover.
    let output: unknown = `Error: unknown tool "${call.name}"`;

    if (tool) {
        const toolContext = { env, idempotencyKey: stepName, run, threadKey, toolCallId: call.id };

        output = await step.do(stepName, () => Promise.resolve(tool.execute(call.input as never, toolContext)));
    }

    await persist({
        content: typeof output === "string" ? output : stringifyOutput(output),
        messageKey: `${instanceId}:tool:${call.id}`,
        role: "tool",
        stepName,
        toolCallId: call.id,
        toolName: call.name,
    });
};

/** One LLM turn: decide, persist, and either finish or execute the tool calls. */
const runTurn = async (turnContext: TurnContext, turn: number): Promise<AgentRunResult | undefined> => {
    const { agent, generate, instanceId, listMessages, memoryContext, persist, run, step, threadKey } = turnContext;

    // The history read feeds the model call, so it lives INSIDE the step body —
    // the memoized decision already accounts for it, and a replay returns the
    // recorded decision without re-reading.
    const decision = await step.do(`llm:turn:${String(turn)}`, async () => {
        const history = (await run(listMessages, { key: threadKey })) as AgentMessageRow[];

        return generate({ messages: buildModelMessages({ history, instructions: agent.instructions, memoryContext }) });
    });

    if (decision.toolCalls.length === 0) {
        await persist({ content: decision.text, messageKey: `${instanceId}:assistant:${String(turn)}`, role: "assistant" });

        return { stopped: "final", text: decision.text, turns: turn + 1 };
    }

    // Persist the assistant's tool-call intent before executing — observers
    // see the pending call, and the rows correlate results.
    await persist({
        content: decision.text,
        messageKey: `${instanceId}:assistant:${String(turn)}`,
        role: "assistant",
        toolCalls: decision.toolCalls,
    });

    // Tool calls run sequentially: their step names memoize each one
    // independently, so a crash between two calls resumes after the completed
    // one.
    for (const call of decision.toolCalls) {
        // eslint-disable-next-line no-await-in-loop -- sequential durable steps ARE the execution model
        await runToolCall(turnContext, call);
    }

    return undefined;
};

/**
 * The durable tool-loop. Correctness rests on two invariants:
 *
 * 1. **Deterministic step names.** Each LLM turn is `llm:turn:N` (`N` = the
 * loop index, replay-stable) and each tool call is `tool:NAME:CALL_ID`
 * (`CALL_ID` = the provider's stable id, itself replayed from the memoized LLM
 * step). Native `step.do` memoization then guarantees a COMPLETED step is
 * never re-run on replay — a resumed run cannot double-charge a card. A step
 * that FAILS mid-body is retried at-least-once; the tool receives its step
 * name as `idempotencyKey` to dedupe on.
 *
 * 2. **Idempotent persistence.** Every message write is keyed
 * `INSTANCE:ROLE:POSITION` and the append mutation dedupes on it, so a
 * replayed persist is a no-op — the thread never duplicates.
 *
 * Loop control derives ONLY from persisted step outputs (never fresh
 * `Date.now()`/`Math.random()` at the top level), so replays walk the same
 * step-name sequence.
 */
const runAgentLoop = async (options: AgentLoopOptions): Promise<AgentRunResult> => {
    const { agent, env, exportName, generate, instanceId, params, paths, run, step } = options;
    const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;

    const appendMessage = toFunctionReference(paths.appendMessage);
    const ensureThread = toFunctionReference(paths.ensureThread);
    const listMessages = toFunctionReference(paths.listMessages);
    const patchThread = toFunctionReference(paths.patchThread);

    const persist = async (message: Record<string, unknown>): Promise<void> => {
        await run(appendMessage, { threadKey: params.threadKey, ...message });
    };

    // Thread bootstrap + user turn. Both are idempotent by themselves (get-or-
    // create; keyed append), so they run outside step.do — a replay converges.
    await run(ensureThread, { agent: exportName, key: params.threadKey, ...(params.title === undefined ? {} : { title: params.title }) });
    await persist({ content: params.input, messageKey: `${instanceId}:user`, role: "user" });

    // Memory step: dispatch the configured retrieval action once per run and
    // inject the assembled context into every turn's prompt.
    let memoryContext: string | undefined;

    if (agent.memory) {
        const memorySource = toFunctionReference(agent.memory.source);
        const { topK } = agent.memory;
        const retrieved = await step.do("memory:retrieve", async () => run(memorySource, { query: params.input, ...(topK === undefined ? {} : { topK }) }));
        const context = (retrieved as { context?: unknown } | undefined)?.context;

        memoryContext = typeof context === "string" && context.length > 0 ? context : undefined;
    }

    const turnContext: TurnContext = {
        agent,
        env,
        generate,
        instanceId,
        listMessages,
        memoryContext,
        persist,
        run,
        step,
        threadKey: params.threadKey,
        tools: agent.tools ?? {},
    };

    try {
        let final: AgentRunResult | undefined;

        for (let turn = 0; turn < maxTurns && final === undefined; turn += 1) {
            // eslint-disable-next-line no-await-in-loop -- turns are inherently sequential (each feeds the next)
            final = await runTurn(turnContext, turn);
        }

        if (final) {
            await run(patchThread, { key: params.threadKey, status: "idle" });

            return final;
        }

        await run(patchThread, { error: `agent stopped: maxTurns (${String(maxTurns)}) reached`, key: params.threadKey, status: "error" });

        return { stopped: "maxTurns", turns: maxTurns };
    } catch (error) {
        // Surface the failure on the thread (observers see status:"error"),
        // then rethrow so the workflow records/retries per its policy.
        await run(patchThread, { error: error instanceof Error ? error.message : String(error), key: params.threadKey, status: "error" });

        throw error;
    }
};

export type { AgentLoopOptions };
export { runAgentLoop };
