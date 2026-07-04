import type { LanguageModel, ModelMessage, StopCondition, ToolSet } from "ai";

import { resolveAgentModel } from "./generate";
import { buildModelMessages } from "./model-messages";
import { agentBindingName } from "./naming";
import { toFunctionReference } from "./paths";
import type {
    AgentConfig,
    AgentDefinition,
    AgentFunctionPaths,
    AgentGenerate,
    AgentGenerateOptions,
    AgentGenerateResult,
    AgentMessageRow,
    AgentRunFunction,
    AgentRunInput,
    AgentRunResult,
    AgentStepFinishInfo,
    AgentStepInfo,
    AgentStepLike,
    AgentStreamGenerate,
    AgentTokenSink,
    AgentToolCall,
    AgentToolContext,
    AgentUsage,
    AgentWorkflowBindingLike,
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

    /**
     * Live-only sink for streamed token deltas. Supplied by the runtime (tees to
     * the existing stream transport); when present together with
     * {@link AgentLoopOptions.streamGenerate} each turn streams its deltas here
     * instead of a single non-streaming `generate` call. Absent (the default)
     * keeps the byte-identical non-streaming path. Never fired on a replay — the
     * memoized turn skips the step body that would emit deltas.
     */
    onTokenDelta?: AgentTokenSink;
    params: AgentRunInput;
    paths: AgentFunctionPaths;
    run: AgentRunFunction;
    step: AgentStepLike;

    /**
     * The streaming LLM-turn seam — production wires AI SDK `streamText`. Used
     * only when {@link AgentLoopOptions.onTokenDelta} is also present; otherwise
     * the loop falls back to {@link AgentLoopOptions.generate} unchanged.
     */
    streamGenerate?: AgentStreamGenerate;
}

const DEFAULT_MAX_TURNS = 8;

/** Everything one turn (and its tool calls) needs, prepared once per run. */
interface TurnContext {
    agent: AgentDefinition;
    env: Record<string, unknown>;
    generate: AgentGenerate;
    /** Read the thread's synced state (dispatches `agents:agentState`) — the tool ctx's `getState`. */
    getState: () => Promise<Record<string, unknown> | undefined>;
    instanceId: string;
    /** The resolved system prompt (static string, or a dynamic thunk's result). */
    instructions: string | undefined;
    listMessages: ReturnType<typeof toFunctionReference>;
    memoryContext: string | undefined;
    /** Live-only token-delta sink, when the runtime provided one (else `undefined`). */
    onTokenDelta: AgentTokenSink | undefined;
    /** Patch this run's thread by key (status/error/usage/…). */
    patchThread: (patch: Record<string, unknown>) => Promise<void>;
    persist: (message: Record<string, unknown>) => Promise<void>;
    run: AgentRunFunction;
    /** Replace the thread's synced state (dispatches `agents:agentSetState`) — the tool ctx's `setState`. */
    setState: (state: Record<string, unknown>) => Promise<void>;
    step: AgentStepLike;
    /** The streaming LLM-turn seam, when available (else `undefined`). */
    streamGenerate: AgentStreamGenerate | undefined;
    threadKey: string;
    tools: Record<string, AnyAgentTool>;
}

/** The decision a client sends to resolve a human-in-the-loop tool approval. */
interface ApprovalDecision {
    decision: "approve" | "reject";
    note?: string;
}

/** JSON-encode a tool's non-string output; `undefined` encodes as "null". */
const stringifyOutput = (output: unknown): string => (output === undefined ? "null" : JSON.stringify(output));

/** Normalize the config's `stopWhen` (a condition or array) to an array. */
const normalizeStopWhen = (stopWhen: AgentConfig["stopWhen"]): ReadonlyArray<StopCondition<ToolSet>> => {
    if (stopWhen === undefined) {
        return [];
    }

    if (Array.isArray(stopWhen)) {
        return stopWhen as ReadonlyArray<StopCondition<ToolSet>>;
    }

    return [stopWhen as StopCondition<ToolSet>];
};

/** Evaluate the user stop conditions against the completed turns (AI SDK semantics). */
const isStopConditionMet = async (conditions: ReadonlyArray<StopCondition<ToolSet>>, steps: ReadonlyArray<AgentStepInfo>): Promise<boolean> => {
    // The AI SDK conditions read `steps.at(-1).toolCalls[].toolName` / `steps.length`;
    // `AgentStepInfo` carries exactly those fields (cast bridges the erased `StepResult`).
    const results = await Promise.all(conditions.map(async (condition) => condition({ steps: steps as never })));

    return results.some(Boolean);
};

/** Sum two optional token counts, preserving `undefined` when neither is set. */
const sumTokens = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

/** Accumulate a turn's usage into the running total (defined fields only). */
const addUsage = (base: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined => {
    if (next === undefined) {
        return base;
    }

    if (base === undefined) {
        return { ...next };
    }

    const result: AgentUsage = {};
    const inputTokens = sumTokens(base.inputTokens, next.inputTokens);
    const outputTokens = sumTokens(base.outputTokens, next.outputTokens);
    const totalTokens = sumTokens(base.totalTokens, next.totalTokens);

    if (inputTokens !== undefined) {
        result.inputTokens = inputTokens;
    }

    if (outputTokens !== undefined) {
        result.outputTokens = outputTokens;
    }

    if (totalTokens !== undefined) {
        result.totalTokens = totalTokens;
    }

    return result;
};

/**
 * Resolve a tool's `needsApproval` gate against the (replay-stable) model input.
 * A boolean gates statically; a function gates per input.
 */
const resolveNeedsApproval = async (tool: AnyAgentTool, input: unknown, context: AgentToolContext): Promise<boolean> => {
    const { needsApproval } = tool;

    if (needsApproval === undefined || needsApproval === false) {
        return false;
    }

    if (needsApproval === true) {
        return true;
    }

    return needsApproval(input, context);
};

/**
 * Pause the run on a human-in-the-loop tool approval: persist an
 * `"awaiting_approval"` marker (filtered out of the model prompt, but observable
 * by a client), move the thread to `"awaiting_input"`, then hibernate on the
 * deterministically named durable event `approval:&lt;toolCallId>`. A workflow
 * replay memoizes the resolved wait, so the run resumes with the recorded
 * decision without pausing (or re-persisting) again. Named ONLY from the
 * replay-stable `call.id`.
 */
const awaitApproval = async (turnContext: TurnContext, call: AgentToolCall): Promise<ApprovalDecision> => {
    const { instanceId, patchThread, persist, step } = turnContext;

    await persist({
        content: `Awaiting approval to run tool "${call.name}".`,
        messageKey: `${instanceId}:approval:${call.id}`,
        role: "tool",
        status: "awaiting_approval",
        toolCallId: call.id,
        toolName: call.name,
    });
    await patchThread({ status: "awaiting_input" });

    const event = await step.waitForEvent<ApprovalDecision>(`approval:${call.id}`, { type: "agent-approval" });

    // Resume: back to running before we act on the decision.
    await patchThread({ status: "running" });

    return { decision: event.payload.decision, ...(event.payload.note === undefined ? {} : { note: event.payload.note }) };
};

const runToolCall = async (turnContext: TurnContext, call: AgentToolCall): Promise<void> => {
    const { env, getState, instanceId, persist, run, setState, step, threadKey, tools } = turnContext;
    const stepName = `tool:${call.name}:${call.id}`;
    const tool: AnyAgentTool | undefined = tools[call.name];
    const messageKey = `${instanceId}:tool:${call.id}`;

    // The model can only call declared tools (the schema constrains it), but a
    // hallucinated name must not crash the run — record it as a failed result
    // so the next turn lets the model recover.
    if (!tool) {
        await persist({ content: `Error: unknown tool "${call.name}"`, messageKey, role: "tool", stepName, toolCallId: call.id, toolName: call.name });

        return;
    }

    const toolContext = { env, getState, idempotencyKey: stepName, run, setState, threadKey, toolCallId: call.id };

    // Human-in-the-loop: a gated tool pauses the run until a client approves or
    // rejects it. A rejection skips the tool and records why, so the next LLM
    // turn can recover instead of stalling.
    let status: "approved" | undefined;

    if (await resolveNeedsApproval(tool, call.input, toolContext)) {
        const { decision, note } = await awaitApproval(turnContext, call);

        if (decision === "reject") {
            const reason = note === undefined ? "" : ` Reason: ${note}`;

            await persist({
                content: `Tool "${call.name}" was rejected by the user and not run.${reason}`,
                messageKey,
                role: "tool",
                status: "rejected",
                stepName,
                toolCallId: call.id,
                toolName: call.name,
            });

            return;
        }

        status = "approved";
    }

    const output: unknown = await step.do(stepName, () => Promise.resolve(tool.execute(call.input as never, toolContext)));

    await persist({
        content: typeof output === "string" ? output : stringifyOutput(output),
        messageKey,
        role: "tool",
        stepName,
        ...(status === undefined ? {} : { status }),
        toolCallId: call.id,
        toolName: call.name,
    });
};

/** The per-turn generation request after applying config defaults + `prepareStep`. */
interface PreparedTurn {
    activeTools: ReadonlyArray<string> | undefined;
    messages: ReadonlyArray<ModelMessage>;
    model: LanguageModel | undefined;
    toolChoice: AgentGenerateOptions["toolChoice"];
}

/**
 * Fold a `prepareStep` result onto the base turn request. A returned `messages`
 * array replaces the assembled history (the seam where history compaction
 * lives); a `system` string prepends a system message; the rest override the
 * per-turn model / tool controls.
 */
const applyPrepareStepResult = (
    base: PreparedTurn,
    overrides: Awaited<ReturnType<NonNullable<AgentConfig["prepareStep"]>>>,
    env: Record<string, unknown>,
): PreparedTurn => {
    if (!overrides) {
        return base;
    }

    let { messages } = base;

    if (overrides.messages !== undefined) {
        messages = overrides.messages;
    }

    if (overrides.system !== undefined) {
        messages = [{ content: overrides.system, role: "system" }, ...messages];
    }

    return {
        activeTools: overrides.activeTools ?? base.activeTools,
        messages,
        model: overrides.model === undefined ? base.model : resolveAgentModel(overrides.model, env),
        toolChoice: overrides.toolChoice ?? base.toolChoice,
    };
};

/**
 * One LLM turn's decision, produced inside the `llm:turn:N` durable step so the
 * whole turn — history read, `prepareStep` overrides, and the model call —
 * memoizes as a unit and a replay returns the recorded decision without
 * re-running any of it. `prepareStep` living inside the step is what keeps a
 * non-deterministic compaction (e.g. an LLM summarization) replay-safe.
 */
const generateTurn = async (turnContext: TurnContext, turn: number, steps: ReadonlyArray<AgentStepInfo>): Promise<AgentGenerateResult> => {
    const { agent, env, generate, instructions, listMessages, memoryContext, onTokenDelta, run, step, streamGenerate, threadKey } = turnContext;

    return step.do(`llm:turn:${String(turn)}`, async () => {
        const history = (await run(listMessages, { key: threadKey })) as AgentMessageRow[];

        let prepared: PreparedTurn = {
            activeTools: agent.activeTools,
            messages: buildModelMessages({ history, instructions, memoryContext }),
            model: undefined,
            toolChoice: agent.toolChoice,
        };

        if (agent.prepareStep) {
            prepared = applyPrepareStepResult(prepared, await agent.prepareStep({ messages: prepared.messages, stepNumber: turn, steps }), env);
        }

        const request: AgentGenerateOptions = {
            messages: prepared.messages,
            ...(prepared.activeTools === undefined ? {} : { activeTools: prepared.activeTools }),
            ...(prepared.model === undefined ? {} : { model: prepared.model }),
            ...(prepared.toolChoice === undefined ? {} : { toolChoice: prepared.toolChoice }),
        };

        // Streaming path: only when the runtime wired BOTH a streaming seam and a
        // live sink. The tee runs here, inside the turn's durable step, so a
        // replay serves the memoized result WITHOUT re-invoking the seam — no
        // delta is re-emitted. The resolved final value is identical to the
        // non-streaming seam's, so the persisted message is unchanged either way.
        if (streamGenerate && onTokenDelta) {
            return streamGenerate(request, (text) => {
                onTokenDelta({ text, threadKey, turn });
            });
        }

        return generate(request);
    });
};

/**
 * Fire the `onStepFinish` observability callback for a turn. It runs inside a
 * named durable step so a user side effect (logging, metrics) fires exactly
 * once per turn even across a replay — the memoized step is skipped on resume.
 */
const notifyStepFinish = async (turnContext: TurnContext, info: AgentStepFinishInfo): Promise<void> => {
    const { agent, step } = turnContext;

    if (!agent.onStepFinish) {
        return;
    }

    await step.do(`agent:step-finish:${String(info.turn)}`, async () => {
        await agent.onStepFinish?.(info);

        return true;
    });
};

/** The `AgentStepInfo` view of a completed turn (feeds `stopWhen` + `prepareStep`). */
const toStepInfo = (decision: AgentGenerateResult): AgentStepInfo => {
    return {
        text: decision.text,
        toolCalls: decision.toolCalls.map((call) => {
            return { input: call.input, toolCallId: call.id, toolName: call.name };
        }),
        ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    };
};

/**
 * Dispatch every configured memory source once per run and return the joined
 * context. Sources run in a STABLE order — the default source (from `memory`)
 * first, then skill `knowledge` in declaration order — each inside its own
 * deterministic durable step. The default source keeps the historic
 * `"memory:retrieve"` name so in-flight runs replay identically; a skill source
 * uses `"memory:retrieve:&lt;key>"`. Sourced from `agent.memorySources` (folded by
 * `defineAgent`), falling back to `agent.memory` alone for a directly-authored
 * definition.
 */
const retrieveMemoryContext = async (agent: AgentDefinition, input: string, step: AgentStepLike, run: AgentRunFunction): Promise<string | undefined> => {
    const sources = agent.memorySources ?? (agent.memory ? [{ key: "default", ...agent.memory }] : []);

    if (sources.length === 0) {
        return undefined;
    }

    const contexts: string[] = [];

    for (const source of sources) {
        const memorySource = toFunctionReference(source.source);
        const { topK } = source;
        const stepName = source.key === "default" ? "memory:retrieve" : `memory:retrieve:${source.key}`;
        // eslint-disable-next-line no-await-in-loop -- sequential durable steps in a stable order ARE the replay-safe execution model
        const retrieved = await step.do(stepName, async () => run(memorySource, { query: input, ...(topK === undefined ? {} : { topK }) }));
        const context = (retrieved as { context?: unknown } | undefined)?.context;

        if (typeof context === "string" && context.length > 0) {
            contexts.push(context);
        }
    }

    return contexts.length > 0 ? contexts.join("\n\n") : undefined;
};

/**
 * Terminate a superseded run's workflow instance after an `onConcurrentRun:
 * "replace"` takeover. Best-effort: an already-gone instance is fine, and taking
 * the thread over (done in `ensureThread`) is what actually prevents the two
 * runs from interleaving. Fired once — a replay re-enters `ensureThread` under
 * the SAME instance id, which no longer reports a takeover.
 */
const terminatePriorInstance = async (env: Record<string, unknown>, exportName: string, priorInstanceId: string): Promise<void> => {
    const binding = env[agentBindingName(exportName)] as AgentWorkflowBindingLike | undefined;

    if (!binding || typeof binding.get !== "function") {
        return;
    }

    try {
        const instance = await binding.get(priorInstanceId);

        await instance.terminate();
    } catch {
        // The prior instance may already be complete/terminated — the takeover stands regardless.
    }
};

/** How the loop proceeds after a turn: finish, stop on a condition, or continue. */
type TurnOutcome = "stopCondition" | undefined | { final: AgentRunResult };

/** A mutable usage accumulator so a thrown turn still surfaces the partial total. */
interface UsageBox {
    value: AgentUsage | undefined;
}

/** The terminal state of the turn loop (before the thread is patched). */
interface LoopResult {
    final: AgentRunResult | undefined;
    stoppedByCondition: boolean;
    turnsRun: number;
}

/**
 * Execute one generated turn's side effects and report the loop's next move.
 *
 * A turn with no tool calls is the final answer: persist it (JSON-encoding a
 * structured `output` when there's no text) and return it. Otherwise persist
 * the tool-call intent, run each call as its own durable step, fire
 * `onStepFinish`, record the step, and — if a `stopWhen` condition now holds —
 * end the loop.
 */
const handleTurn = async (
    turnContext: TurnContext,
    turn: number,
    decision: AgentGenerateResult,
    steps: AgentStepInfo[],
    stopConditions: ReadonlyArray<StopCondition<ToolSet>>,
): Promise<TurnOutcome> => {
    const { instanceId, persist } = turnContext;
    const stepUsage = decision.usage === undefined ? {} : { usage: decision.usage };

    if (decision.toolCalls.length === 0) {
        // A structured answer with no text renders as its JSON so the persisted
        // message still carries the model's decision.
        const content = decision.output !== undefined && decision.text.length === 0 ? stringifyOutput(decision.output) : decision.text;

        await persist({ content, messageKey: `${instanceId}:assistant:${String(turn)}`, role: "assistant" });
        await notifyStepFinish(turnContext, { text: decision.text, toolCalls: [], turn, ...stepUsage });

        return {
            final: {
                stopped: "final",
                text: decision.text,
                turns: turn + 1,
                ...(decision.output === undefined ? {} : { output: decision.output }),
            },
        };
    }

    // Persist the assistant's tool-call intent before executing — observers see
    // the pending call, and the rows correlate results.
    await persist({ content: decision.text, messageKey: `${instanceId}:assistant:${String(turn)}`, role: "assistant", toolCalls: decision.toolCalls });

    // Tool calls run sequentially: their step names memoize each one
    // independently, so a crash between two calls resumes after the completed one.
    for (const call of decision.toolCalls) {
        // eslint-disable-next-line no-await-in-loop -- sequential durable steps ARE the execution model
        await runToolCall(turnContext, call);
    }

    await notifyStepFinish(turnContext, { text: decision.text, toolCalls: decision.toolCalls, turn, ...stepUsage });

    steps.push(toStepInfo(decision));

    // `stopWhen` composes with `maxTurns`: after a tool-call turn, a met
    // condition ends the loop even though the model asked to continue.
    if (stopConditions.length > 0 && (await isStopConditionMet(stopConditions, steps))) {
        return "stopCondition";
    }

    return undefined;
};

/**
 * Drive turns until a final answer, a `stopWhen` condition, or `maxTurns`.
 * Usage accrues into `usageBox` (not the return) so a mid-loop throw still
 * leaves the partial total visible to the caller's error handler.
 */
const runTurns = async (
    turnContext: TurnContext,
    maxTurns: number,
    stopConditions: ReadonlyArray<StopCondition<ToolSet>>,
    usageBox: UsageBox,
): Promise<LoopResult> => {
    const steps: AgentStepInfo[] = [];
    let final: AgentRunResult | undefined;
    let stoppedByCondition = false;
    let turnsRun = 0;

    for (let turn = 0; turn < maxTurns; turn += 1) {
        // eslint-disable-next-line no-await-in-loop -- turns are inherently sequential (each feeds the next)
        const decision = await generateTurn(turnContext, turn, steps);

        // eslint-disable-next-line no-param-reassign -- `usageBox` is a deliberate out-param so a thrown turn keeps the partial total
        usageBox.value = addUsage(usageBox.value, decision.usage);
        turnsRun = turn + 1;

        // eslint-disable-next-line no-await-in-loop -- one durable turn at a time (persist → tools → callbacks)
        const outcome = await handleTurn(turnContext, turn, decision, steps, stopConditions);

        if (outcome === "stopCondition") {
            stoppedByCondition = true;

            break;
        }

        if (outcome !== undefined) {
            final = outcome.final;

            break;
        }
    }

    return { final, stoppedByCondition, turnsRun };
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
    const { agent, env, exportName, generate, instanceId, onTokenDelta, params, paths, run, step, streamGenerate } = options;
    const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;
    const stopConditions = normalizeStopWhen(agent.stopWhen);

    const appendMessage = toFunctionReference(paths.appendMessage);
    const ensureThread = toFunctionReference(paths.ensureThread);
    const listMessages = toFunctionReference(paths.listMessages);
    const patchThread = toFunctionReference(paths.patchThread);
    const setStateRef = toFunctionReference(paths.setState);
    const stateRef = toFunctionReference(paths.state);

    const persist = async (message: Record<string, unknown>): Promise<void> => {
        await run(appendMessage, { threadKey: params.threadKey, ...message });
    };

    const patchThreadByKey = async (patch: Record<string, unknown>): Promise<void> => {
        await run(patchThread, { key: params.threadKey, ...patch });
    };

    // Synced-state closures handed to every tool ctx. They dispatch through the
    // same `run` seam the loop uses for history/persistence, so a call made from
    // inside a tool's memoized `step.do` is replay-safe (the memoized step is
    // served without re-dispatching). `getState` reads the owner-gated
    // `agentState` query (same identity/gate as `agentMessages`); `setState` is
    // an absolute REPLACE, idempotent under an at-least-once step retry.
    const getState = async (): Promise<Record<string, unknown> | undefined> =>
        (await run(stateRef, { key: params.threadKey })) as Record<string, unknown> | undefined;

    const setState = async (state: Record<string, unknown>): Promise<void> => {
        await run(setStateRef, { key: params.threadKey, state });
    };

    // Thread bootstrap + user turn. Both are idempotent by themselves (get-or-
    // create; keyed append), so they run outside step.do — a replay converges.
    // Passing `instanceId` lets the guard tell this run apart from a concurrent
    // one (a replay re-runs with the SAME id, so it is never rejected). A reject
    // throws HERE, before the try below, so a second run fails fast WITHOUT
    // touching the in-flight run's thread.
    const bootstrap = (await run(ensureThread, {
        agent: exportName,
        instanceId,
        key: params.threadKey,
        ...(agent.initialState === undefined ? {} : { initialState: agent.initialState }),
        ...(agent.onConcurrentRun === undefined ? {} : { onConcurrentRun: agent.onConcurrentRun }),
        ...(params.owner === undefined ? {} : { owner: params.owner }),
        ...(params.title === undefined ? {} : { title: params.title }),
    })) as { created: boolean; priorInstanceId?: string; replaced?: boolean } | undefined;

    // Replace policy: the thread has been taken over — terminate the run it was
    // taken from so it cannot resume and race on the shared seq counter.
    if (bootstrap?.replaced && bootstrap.priorInstanceId !== undefined) {
        await terminatePriorInstance(env, exportName, bootstrap.priorInstanceId);
    }

    await persist({ content: params.input, messageKey: `${instanceId}:user`, role: "user" });

    // Memory step: dispatch the configured retrieval action once per run and
    // inject the assembled context into every turn's prompt.
    const memoryContext = await retrieveMemoryContext(agent, params.input, step, run);

    // Resolve the system prompt once per run. A dynamic `instructions` thunk is
    // pure (env + run params in, string out), so calling it at the top level is
    // replay-stable — the same context yields the same prompt on a resume.
    const instructions =
        typeof agent.instructions === "function" ? agent.instructions({ env, input: params.input, threadKey: params.threadKey }) : agent.instructions;

    const turnContext: TurnContext = {
        agent,
        env,
        generate,
        getState,
        instanceId,
        instructions,
        listMessages,
        memoryContext,
        onTokenDelta,
        patchThread: patchThreadByKey,
        persist,
        run,
        setState,
        step,
        streamGenerate,
        threadKey: params.threadKey,
        tools: agent.tools ?? {},
    };

    // The running usage total derives only from memoized step outputs, so a
    // replay rebuilds it identically; a box keeps the partial visible on throw.
    const usageBox: UsageBox = { value: undefined };

    try {
        const { final, stoppedByCondition, turnsRun } = await runTurns(turnContext, maxTurns, stopConditions, usageBox);
        const usagePatch = usageBox.value === undefined ? {} : { usage: usageBox.value };

        if (final) {
            await run(patchThread, { key: params.threadKey, status: "idle", ...usagePatch });

            return { ...final, ...usagePatch };
        }

        if (stoppedByCondition) {
            // A stop condition is a deliberate end, not a failure — leave the
            // thread idle so it can continue on the next run.
            await run(patchThread, { key: params.threadKey, status: "idle", ...usagePatch });

            return { stopped: "stopCondition", turns: turnsRun, ...usagePatch };
        }

        await run(patchThread, { error: `agent stopped: maxTurns (${String(maxTurns)}) reached`, key: params.threadKey, status: "error", ...usagePatch });

        return { stopped: "maxTurns", turns: maxTurns, ...usagePatch };
    } catch (error) {
        // Surface the failure on the thread (observers see status:"error"),
        // then rethrow so the workflow records/retries per its policy.
        await run(patchThread, {
            error: error instanceof Error ? error.message : String(error),
            key: params.threadKey,
            status: "error",
            ...(usageBox.value === undefined ? {} : { usage: usageBox.value }),
        });

        throw error;
    }
};

export type { AgentLoopOptions };
export { runAgentLoop };
