import type { LanguageModel, ModelMessage, StopCondition, ToolSet } from "ai";

import { APPROVAL_TIMEOUT_MAX_MS, definedColumns } from "./component-shared";
import { resolveAgentModel } from "./generate";
import { firstEpisodicSource, firstGraphSource, memoryStepName, resolveInjectedSources } from "./memory";
import { buildModelMessages } from "./model-messages";
import { agentBindingName } from "./naming";
import { toFunctionReference } from "./paths";
import isPositiveInteger from "./positive-integer";
import type {
    AgentApprovalContext,
    AgentCompact,
    AgentConfig,
    AgentDefinition,
    AgentEpisodeExtract,
    AgentFunctionPaths,
    AgentGenerate,
    AgentGenerateOptions,
    AgentGenerateResult,
    AgentGraphExtract,
    AgentMemoryOptions,
    AgentMemorySource,
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
    AgentUsage,
    AgentWorkflowBindingLike,
    AnyAgentTool,
    EnsureThreadOutcome,
} from "./types";

/**
 * `AgentLoopOptions` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
interface AgentLoopOptions {
    agent: AgentDefinition;

    /**
     * The history-compaction seam — production wires AI SDK `generateText`.
     * Absent (the default) disables compaction, so an agent with no `compaction`
     * config, and every unit test that doesn't opt in, is byte-identical.
     */
    compact?: AgentCompact;
    env: Record<string, unknown>;
    /** The agent's `lunora/agents.ts` export name (thread attribution). */
    exportName: string;

    /**
     * The run-end episode-summary seam — production wires AI SDK `generateText`.
     * Absent (the default) disables episode recording, so an agent with no
     * episodic memory, and every unit test that doesn't opt in, is byte-identical.
     */
    extractEpisode?: AgentEpisodeExtract;

    /**
     * The run-end graph-extraction seam — production wires AI SDK `generateText`
     * with a structured `Output.object`. Absent (the default) disables
     * extraction, so an agent with no graph memory, and every unit test that
     * doesn't opt in, is byte-identical.
     */
    extractGraph?: AgentGraphExtract;
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

/**
 * The run's sub-agent delegation depth, floored at 0. A caller-supplied depth
 * only ever RESTRICTS how far this run may delegate (see `as-tool.ts`), so a
 * bogus one — absent, negative, fractional — is treated as a top-level run.
 */
const normalizeDepth = (depth: number | undefined): number => (isPositiveInteger(depth) ? depth : 0);

/** Everything one turn (and its tool calls) needs, prepared once per run. */
interface TurnContext {
    agent: AgentDefinition;
    /** History-compaction seam, when the runtime provided one (else `undefined`). */
    compact: AgentCompact | undefined;
    /** Patch this run's thread by key (status/error/usage/…). */
    /** Retire a persisted message by key (dispatches `agents:agentDeleteMessage`). */
    deleteMessage: (messageKey: string) => Promise<void>;
    /** Sub-agent delegation depth of THIS run (`params.depth`), handed to every tool context. */
    depth: number;
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
const normalizeStopWhen = (stopWhen: AgentConfig["stopWhen"]): ReadonlyArray<StopCondition<ToolSet>> => (stopWhen === undefined ? [] : [stopWhen].flat());

/** Evaluate the user stop conditions against the completed turns (AI SDK semantics). */
const isStopConditionMet = async (conditions: ReadonlyArray<StopCondition<ToolSet>>, steps: ReadonlyArray<AgentStepInfo>): Promise<boolean> => {
    // The AI SDK conditions read `steps.at(-1).toolCalls[].toolName` / `steps.length`;
    // `AgentStepInfo` carries exactly those fields (cast bridges the erased `StepResult`).
    const results = await Promise.all(conditions.map(async (condition) => condition({ steps: steps as never })));

    return results.some(Boolean);
};

/** Accumulate a turn's usage into the running total (defined fields only; a field absent on both sides stays absent). */
const addUsage = (base: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined => {
    if (next === undefined) {
        return base;
    }

    if (base === undefined) {
        return { ...next };
    }

    const result: AgentUsage = {};

    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        if (base[key] !== undefined || next[key] !== undefined) {
            result[key] = (base[key] ?? 0) + (next[key] ?? 0);
        }
    }

    return result;
};

/**
 * Resolve a tool's `needsApproval` gate against the (replay-stable) model
 * input. The `true`/`false`/`undefined` forms are compile-time constants —
 * replay re-derives them identically for free, so they stay outside any
 * durable step. The FUNCTION form can read `getState`/`run` and so can be
 * non-deterministic or (if misused) side-effecting; it is memoized in its own
 * durable step (`gateStepName`, distinct from the tool's own step — see
 * `runToolCall`) so it now resolves exactly ONCE per call, not once per replay.
 */
const resolveNeedsApproval = async (
    tool: AnyAgentTool,
    input: unknown,
    step: AgentStepLike,
    gateStepName: string,
    context: AgentApprovalContext,
): Promise<boolean> => {
    const { needsApproval } = tool;

    if (needsApproval === undefined || needsApproval === false) {
        return false;
    }

    if (needsApproval === true) {
        return true;
    }

    return step.do(gateStepName, async () => needsApproval(input, context));
};

/**
 * Cloudflare Workflows raises an elapsed `waitForEvent` as an `Error` named
 * `WorkflowTimeoutError` (message `"Execution timed out after <n>ms"`). Matched
 * by NAME rather than `instanceof`: the constructor lives in the host's own
 * `workflows-shared` module, which we neither import nor can identity-compare
 * across the RPC boundary. Same shape as `channels.ts`'s duplicate-instance
 * check, and deliberately narrow — every OTHER rejection (a binding failure, a
 * payload that will not deserialize, a host bug) must NOT be silently recorded
 * as a human decision.
 */
const WORKFLOW_TIMEOUT_ERROR_NAME = "WorkflowTimeoutError";

/** True only for the host's elapsed-`waitForEvent` rejection — see {@link WORKFLOW_TIMEOUT_ERROR_NAME}. */
const isWaitTimeoutError = (error: unknown): boolean => error instanceof Error && error.name === WORKFLOW_TIMEOUT_ERROR_NAME;

/**
 * How long a HITL approval wait hibernates before it gives up (overridable per
 * agent via `approvalTimeout`). A slow approver is the NORMAL case — overnight
 * or over a weekend — so the default is generous; but with no bound at all a
 * never-answered approval hibernates the instance forever, and once the
 * thread's staleness horizon passes, its pending approval can never be
 * resolved again. The reclaim horizon is derived from
 * `APPROVAL_TIMEOUT_MAX_MS`, so the wait always fires first by construction.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000;

/** Milliseconds per unit of the host's duration grammar (`"3 days"`); month/year are nominal. */
const DURATION_UNIT_MS: Record<string, number> = {
    day: 86_400_000,
    hour: 3_600_000,
    minute: 60_000,
    month: 30 * 86_400_000,
    second: 1000,
    week: 7 * 86_400_000,
    year: 365 * 86_400_000,
};

/** The host's `"<n> <unit>[s]"` duration grammar (hoisted, avoids recompilation). */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?) (day|hour|minute|month|second|week|year)s?$/u;

/**
 * Resolve the agent's configured approval timeout to a bounded number of
 * milliseconds.
 *
 * Returns ms (which `waitForEvent` accepts natively) rather than passing the
 * configured value through, because the bound is the point: a value above
 * {@link APPROVAL_TIMEOUT_MAX_MS} would let the thread be reclaimed out from
 * under a still-pending approval. An unparseable string cannot reach here from
 * TypeScript (the property's type is the host's closed grammar) but can from
 * plain JS — it falls back to the default rather than handing the host a
 * duration it will reject mid-run.
 */
const approvalTimeoutMs = (configured: number | string | undefined): number => {
    if (configured === undefined) {
        return DEFAULT_APPROVAL_TIMEOUT_MS;
    }

    if (typeof configured === "number") {
        return Math.min(configured, APPROVAL_TIMEOUT_MAX_MS);
    }

    const match = DURATION_PATTERN.exec(configured);

    if (match === null) {
        return DEFAULT_APPROVAL_TIMEOUT_MS;
    }

    return Math.min(Number(match[1]) * (DURATION_UNIT_MS[match[2] as string] as number), APPROVAL_TIMEOUT_MAX_MS);
};

/**
 * Pause the run on a human-in-the-loop tool approval: persist an
 * `"awaiting_approval"` marker (filtered out of the model prompt, but observable
 * by a client), move the thread to `"awaiting_input"`, then hibernate on the
 * deterministically named durable event `approval:<toolCallId>`. A workflow
 * replay memoizes the resolved wait, so the run resumes with the recorded
 * decision without pausing (or re-persisting) again. Named ONLY from the
 * replay-stable `call.id`. The wait carries a timeout (default
 * {@link DEFAULT_APPROVAL_TIMEOUT_MS}, configurable via the agent's
 * `approvalTimeout` and bounded by {@link approvalTimeoutMs}) so a
 * never-answered approval ends as a rejection instead of hibernating the run
 * forever.
 *
 * The wait's match `type` is scoped to THIS call (`agent-approval:<call.id>`,
 * the same format `component.ts`'s `agentResolveApproval` sends) — native CF
 * Workflows matches an incoming event against a waiter by `type`, not by the
 * durable step name, so without this an approval meant for a different
 * pending tool call on the same instance could resolve this one instead.
 */
const awaitApproval = async (turnContext: TurnContext, call: AgentToolCall): Promise<ApprovalDecision> => {
    const { agent, deleteMessage, instanceId, patchThread, persist, step } = turnContext;

    await persist({
        content: `Awaiting approval to run tool "${call.name}".`,
        messageKey: `${instanceId}:approval:${call.id}`,
        role: "tool",
        status: "awaiting_approval",
        toolCallId: call.id,
        toolName: call.name,
    });
    await patchThread({ status: "awaiting_input" });

    const decision = await step
        .waitForEvent<ApprovalDecision>(`approval:${call.id}`, {
            timeout: approvalTimeoutMs(agent.approvalTimeout),
            type: `agent-approval:${call.id}`,
        })
        .then((event): ApprovalDecision => {
            return { decision: event.payload.decision, ...(event.payload.note === undefined ? {} : { note: event.payload.note }) };
        })
        .catch((error: unknown): ApprovalDecision => {
            // ONLY an elapsed timeout becomes a decision. Without it the run
            // hibernates forever and, once the thread's staleness horizon
            // passes, the pending approval is permanently unresolvable — so a
            // timeout is recorded as a rejection and the loop continues down
            // the existing rejection path. Any OTHER rejection (binding
            // failure, undeserializable payload, host bug) is rethrown: writing
            // a rejection into the durable record when nobody was asked would
            // be a worse lie than a failed run, and the sibling `awaitDequeue`
            // propagates host errors for the same reason.
            if (!isWaitTimeoutError(error)) {
                throw error;
            }

            return { decision: "reject", note: "approval timed out" };
        });

    // Retire the marker the moment a decision is reached — by a human OR by the
    // timeout. Every client reads this row alone to decide whether to OFFER an
    // Approve/Reject, so leaving it behind keeps advertising an action that can
    // no longer be delivered (the instance that would receive it is finished).
    // It is deleted rather than restatused because any non-"awaiting_approval"
    // status turns it into a second, bogus tool RESULT — see the mutation's
    // docstring. The real outcome lands on the tool-result row next.
    // All three outcomes strand the same marker, so this is not on the timeout
    // branch alone.
    await deleteMessage(`${instanceId}:approval:${call.id}`);

    // Resume: back to running before we act on the decision.
    await patchThread({ status: "running" });

    return decision;
};

const runToolCall = async (turnContext: TurnContext, call: AgentToolCall): Promise<void> => {
    const { depth, env, getState, instanceId, onTokenDelta, persist, run, setState, step, threadKey, tools } = turnContext;
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

    // Ephemeral progress: tees onto the SAME live-only sink the token deltas
    // ride. A no-op when the runtime wired no sink (the durable default), and —
    // because it fires from inside the tool's memoized `step.do` below — never
    // re-emitted on replay of a completed step.
    const reportProgress = (data: unknown): void => {
        onTokenDelta?.({ data, kind: "progress", threadKey, toolCallId: call.id });
    };

    const toolContext = { depth, env, getState, idempotencyKey: stepName, reportProgress, run, setState, step, threadKey, toolCallId: call.id };
    // The gate's view: everything `toolContext` has EXCEPT `setState` — a gate
    // that mutates state is a side effect inside a decision predicate, which is
    // exactly the misuse durability here is fixing, not relocating.
    const gateContext: AgentApprovalContext = { depth, env, getState, idempotencyKey: stepName, run, threadKey, toolCallId: call.id };
    // Distinct from `stepName` (`tool:${call.name}:${call.id}`) so
    // `@lunora/workflow`'s BY-NAME step memoization can never confuse the gate's
    // durable result with the tool's own (see the advisor's duplicate-step-name
    // lint for this collision class). Keyed on `call.id` alone (the
    // replay-stable identity `stepName` and `approval:${call.id}` already
    // trust), so it stays collision-free per call.
    const gateStepName = `tool:approval-gate:${call.id}`;

    // Human-in-the-loop: a gated tool pauses the run until a client approves or
    // rejects it. A rejection skips the tool and records why, so the next LLM
    // turn can recover instead of stalling.
    let status: "approved" | undefined;

    if (await resolveNeedsApproval(tool, call.input, step, gateStepName, gateContext)) {
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
 * Decide the compaction split for a turn: when `compaction` is configured and the
 * history exceeds `maxMessages`, return the `older` messages to summarize and the
 * `recent` tail to keep verbatim (the most recent `keepRecent`, default
 * `ceil(maxMessages / 2)`). Returns `undefined` when compaction is unset, the
 * history is short enough, or the tail would be the whole history — a PURE
 * decision (no I/O), unit-testable in isolation.
 * @experimental
 */
const splitForCompaction = (
    history: ReadonlyArray<AgentMessageRow>,
    compaction: AgentConfig["compaction"],
): { older: AgentMessageRow[]; recent: AgentMessageRow[] } | undefined => {
    if (compaction === undefined || history.length <= compaction.maxMessages) {
        return undefined;
    }

    const keepRecent = Math.max(1, compaction.keepRecent ?? Math.ceil(compaction.maxMessages / 2));

    if (history.length <= keepRecent) {
        return undefined;
    }

    // Snap the boundary OFF a `tool` row: a kept `recent` tail that starts on a
    // tool-result whose assistant tool-call was summarized into `older` produces
    // an orphaned tool-result the model provider rejects (400). Moving the cut
    // earlier (past leading tool rows onto the assistant/user/system row) keeps
    // every tool-call/result pair on one side — which also stops `older` ending
    // mid-pair. If that consumes the whole older set, skip compaction this turn.
    let cut = history.length - keepRecent;

    while (cut > 0 && history[cut]?.role === "tool") {
        cut -= 1;
    }

    if (cut <= 0) {
        return undefined;
    }

    return { older: history.slice(0, cut), recent: history.slice(cut) };
};

/**
 * Apply automatic history compaction for a turn. Shared with the in-DO voice
 * pipeline (`voice-turn.ts`), which runs on the SAME thread — an agent that
 * configures compaction must get it on a voice turn too, or a long conversation
 * silently sends the whole history on every spoken turn.
 *
 * When {@link splitForCompaction} decides to compact and a `compact` seam is
 * present, summarize the older messages and return the recent tail plus the
 * summary; otherwise return the history unchanged. Called INSIDE the durable
 * loop's memoized turn step (and inline on a voice turn), so the LLM
 * summarization is replay-safe. Best-effort: a summarization throw falls back to
 * the full, uncompacted history rather than failing the turn.
 *
 * COST: the brief is recomputed per FRESH turn (a replay serves it from the memo),
 * so a long multi-turn run over the threshold issues one summarization call per
 * turn — the price of the per-turn memoized-step model. Persisting a running brief
 * to reuse across turns is a deliberate future optimization.
 */
const compactHistory = async (
    context: { agent: AgentConfig; compact: AgentCompact | undefined; env: Record<string, unknown> },
    history: AgentMessageRow[],
): Promise<{ history: AgentMessageRow[]; summary: string | undefined }> => {
    const { agent, compact, env } = context;
    const split = splitForCompaction(history, agent.compaction);

    if (split === undefined || compact === undefined) {
        return { history, summary: undefined };
    }

    try {
        const summary = await compact({ env, messages: buildModelMessages({ history: split.older }), model: agent.compaction?.model ?? agent.model });

        return summary.length > 0 ? { history: split.recent, summary } : { history, summary: undefined };
    } catch {
        // A failed summary is non-fatal — fall back to the full history.
        return { history, summary: undefined };
    }
};

/**
 * One LLM turn's decision, produced inside the `llm:turn:N` durable step so the
 * whole turn — history read, compaction, `prepareStep` overrides, and the model
 * call — memoizes as a unit and a replay returns the recorded decision without
 * re-running any of it. Compaction and `prepareStep` living inside the step is
 * what keeps a non-deterministic summarization replay-safe.
 */
const generateTurn = async (turnContext: TurnContext, turn: number, steps: ReadonlyArray<AgentStepInfo>): Promise<AgentGenerateResult> => {
    const { agent, env, generate, instructions, listMessages, memoryContext, onTokenDelta, run, step, streamGenerate, threadKey } = turnContext;

    return step.do(`llm:turn:${String(turn)}`, async () => {
        const rawHistory = (await run(listMessages, { key: threadKey })) as AgentMessageRow[];
        const { history, summary } = await compactHistory(turnContext, rawHistory);

        let prepared: PreparedTurn = {
            activeTools: agent.activeTools,
            messages: buildModelMessages({ history, instructions, memoryContext, summary }),
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

/** Read a dispatched retrieval's `{ context }` field, treating empty/missing as no hit. */
const readRetrievedContext = (retrieved: unknown): string | undefined => {
    const context = (retrieved as { context?: unknown } | undefined)?.context;

    return typeof context === "string" && context.length > 0 ? context : undefined;
};

/** The traversal bounds forwarded to `agentGraphTraverse` — the `graph` config minus `extractionModel` (a write-path concern). */
const graphTraverseBounds = (graph: AgentMemoryOptions["graph"]): Record<string, number> =>
    definedColumns({ depth: graph?.depth, fanOut: graph?.fanOut, maxNodes: graph?.maxNodes, maxSeeds: graph?.maxSeeds }) as Record<string, number>;

/** Dispatch a `"semantic"` source's RAG action as a `memory:retrieve[:<key>]` step and read its context. */
const dispatchSemanticMemory = async (source: AgentMemorySource, input: string, step: AgentStepLike, run: AgentRunFunction): Promise<string | undefined> => {
    // A semantic source without a `source` is rejected at `defineAgent`; guard
    // defensively for a hand-built definition that bypassed it.
    if (source.source === undefined) {
        return undefined;
    }

    const memorySource = toFunctionReference(source.source);
    const { topK } = source;
    const stepName = memoryStepName("memory:retrieve", source.key);
    const retrieved = await step.do(stepName, async () => run(memorySource, { query: input, ...(topK === undefined ? {} : { topK }) }));

    return readRetrievedContext(retrieved);
};

/**
 * Dispatch a `"graph"` source's owner-scoped traversal as a `memory:traverse[:<key>]`
 * step and read its context. Owner-scoped by design: an anonymous run (no `owner`)
 * has no graph to read, so the source no-ops for that run.
 */
const dispatchGraphMemory = async (
    source: AgentMemorySource,
    input: string,
    owner: string | undefined,
    graphTraverse: ReturnType<typeof toFunctionReference>,
    step: AgentStepLike,
    run: AgentRunFunction,
): Promise<string | undefined> => {
    if (owner === undefined) {
        return undefined;
    }

    const stepName = memoryStepName("memory:traverse", source.key);
    const retrieved = await step.do(stepName, async () => run(graphTraverse, { owner, query: input, ...graphTraverseBounds(source.graph) }));

    return readRetrievedContext(retrieved);
};

/**
 * Dispatch an `"episodic"` source's recency recall as a `memory:recall[:<key>]`
 * step and read its context. Owner-scoped by design: an anonymous run (no
 * `owner`) has no episode timeline, so the source no-ops for that run.
 */
const dispatchEpisodicMemory = async (
    source: AgentMemorySource,
    owner: string | undefined,
    episodeRecall: ReturnType<typeof toFunctionReference>,
    step: AgentStepLike,
    run: AgentRunFunction,
): Promise<string | undefined> => {
    if (owner === undefined) {
        return undefined;
    }

    const stepName = memoryStepName("memory:recall", source.key);
    const recallArgs = { owner, ...(source.episodic?.recall === undefined ? {} : { limit: source.episodic.recall }) };
    const retrieved = await step.do(stepName, async () => run(episodeRecall, recallArgs));

    return readRetrievedContext(retrieved);
};

/**
 * Dispatch every configured memory source once per run and return the joined
 * context. Sources run in a STABLE order — the default source (from `memory`)
 * first, then skill `knowledge` in declaration order — each inside its own
 * deterministic durable step. A `"semantic"` source keeps the historic
 * `"memory:retrieve[:<key>]"` name so in-flight runs replay identically; a
 * `"graph"` source uses the `"memory:traverse[:<key>]"` namespace (which can't
 * collide). Sourced from `agent.memorySources` (folded by `defineAgent`), falling
 * back to `agent.memory` alone for a directly-authored definition.
 */
/** Route one injected source to its dispatcher by kind (episodic / graph / semantic). */
const dispatchInjectedSource = async (
    source: AgentMemorySource,
    deps: {
        episodeRecall: ReturnType<typeof toFunctionReference>;
        graphTraverse: ReturnType<typeof toFunctionReference>;
        input: string;
        owner: string | undefined;
        run: AgentRunFunction;
        step: AgentStepLike;
    },
): Promise<string | undefined> => {
    if (source.kind === "episodic") {
        return dispatchEpisodicMemory(source, deps.owner, deps.episodeRecall, deps.step, deps.run);
    }

    if (source.kind === "graph") {
        return dispatchGraphMemory(source, deps.input, deps.owner, deps.graphTraverse, deps.step, deps.run);
    }

    return dispatchSemanticMemory(source, deps.input, deps.step, deps.run);
};

/**
 * Drop all but the FIRST episodic source. Episodic recall is owner-global
 * (identical for every episodic source) and only the first is the write target,
 * so injecting more than one would duplicate the same timeline. Collapsing it
 * here keeps the injection loop uniform (no per-source special case).
 */
const dedupeEpisodicSources = (sources: ReadonlyArray<AgentMemorySource>): AgentMemorySource[] => {
    const first = sources.findIndex((source) => source.kind === "episodic");

    return sources.filter((source, index) => source.kind !== "episodic" || index === first);
};

const retrieveMemoryContext = async (
    agent: AgentDefinition,
    input: string,
    owner: string | undefined,
    paths: AgentFunctionPaths,
    step: AgentStepLike,
    run: AgentRunFunction,
): Promise<string | undefined> => {
    // The injected source set: the list `defineAgent` folded, else the
    // directly-authored `memory` as the `"default"` source (an `"agentic"`-mode
    // semantic memory is excluded — it mints a `searchMemory` tool instead).
    // Collapse duplicate episodic sources up front so the loop body is uniform.
    const sources = dedupeEpisodicSources(resolveInjectedSources(agent));

    if (sources.length === 0) {
        return undefined;
    }

    const graphTraverse = toFunctionReference(paths.graphTraverse);
    const episodeRecall = toFunctionReference(paths.episodeRecall);
    const contexts: string[] = [];

    for (const source of sources) {
        // eslint-disable-next-line no-await-in-loop -- sequential durable steps in a stable order ARE the replay-safe execution model
        const context = await dispatchInjectedSource(source, { episodeRecall, graphTraverse, input, owner, run, step });

        if (context !== undefined) {
            contexts.push(context);
        }
    }

    return contexts.length > 0 ? contexts.join("\n\n") : undefined;
};

/**
 * Run-end owner-scoped graph extraction. When a graph memory source is configured
 * and the run has an `owner` + a final answer, extract entities/relations from the
 * exchange in a MEMOIZED `memory:extract[:<key>]` step (the model never re-runs on
 * replay), then upsert them via an IDEMPOTENT dispatch keyed by the instance (the
 * `byTriple` dedup + absolute-max weight converge on replay). No-ops otherwise —
 * an anonymous run has no graph scope, and a run with no graph source or no
 * `extractGraph` seam skips extraction entirely (byte-identical to before).
 *
 * Best-effort: a knowledge-extraction failure must not fail a run whose answer is
 * already persisted, so a throw here is swallowed (the memoized step still
 * guarantees a SUCCESSFUL extraction never re-runs).
 */
const extractGraphMemoryAtRunEnd = async (options: {
    agent: AgentDefinition;
    env: Record<string, unknown>;
    extractGraph: AgentGraphExtract | undefined;
    finalText: string | undefined;
    input: string;
    instanceId: string;
    owner: string | undefined;
    paths: AgentFunctionPaths;
    run: AgentRunFunction;
    step: AgentStepLike;
}): Promise<void> => {
    const { agent, env, extractGraph, finalText, input, instanceId, owner, paths, run, step } = options;

    if (extractGraph === undefined || owner === undefined || finalText === undefined || finalText.length === 0) {
        return;
    }

    const source = firstGraphSource(agent);

    if (source === undefined) {
        return;
    }

    try {
        const graphInput = { assistantText: finalText, env, model: source.graph?.extractionModel ?? agent.model, userInput: input };
        const extracted = await step.do(memoryStepName("memory:extract", source.key), async () => extractGraph(graphInput));

        await run(toFunctionReference(paths.graphUpsert), { ...extracted, messageKey: `${instanceId}:${memoryStepName("extract", source.key)}`, owner });
    } catch {
        // A failed extraction is non-fatal — the answer is already persisted.
    }
};

/**
 * Run-end owner-scoped episode recording. When an episodic memory source is
 * configured and the run has an `owner` + a final answer, summarize the exchange
 * in a MEMOIZED `memory:episode[:<key>]` step (the model never re-runs on
 * replay), then record it via an IDEMPOTENT dispatch keyed by the instance (the
 * `byOwnerMessageKey` unique index no-ops a replay). No-ops otherwise — an
 * anonymous run has no episode scope, and a run with no episodic source or no
 * `extractEpisode` seam skips it entirely (byte-identical to before).
 *
 * Best-effort: a summarization failure must not fail a run whose answer is
 * already persisted, so a throw here is swallowed.
 */
const extractEpisodeAtRunEnd = async (options: {
    agent: AgentDefinition;
    env: Record<string, unknown>;
    extractEpisode: AgentEpisodeExtract | undefined;
    finalText: string | undefined;
    input: string;
    instanceId: string;
    owner: string | undefined;
    paths: AgentFunctionPaths;
    run: AgentRunFunction;
    step: AgentStepLike;
    threadKey: string;
}): Promise<void> => {
    const { agent, env, extractEpisode, finalText, input, instanceId, owner, paths, run, step, threadKey } = options;

    if (extractEpisode === undefined || owner === undefined || finalText === undefined || finalText.length === 0) {
        return;
    }

    const source = firstEpisodicSource(agent);

    if (source === undefined) {
        return;
    }

    try {
        const episodeInput = { assistantText: finalText, env, model: source.episodic?.extractionModel ?? agent.model, userInput: input };
        const { summary } = await step.do(memoryStepName("memory:episode", source.key), async () => extractEpisode(episodeInput));

        await run(toFunctionReference(paths.episodeUpsert), {
            messageKey: `${instanceId}:${memoryStepName("episode", source.key)}`,
            owner,
            summary,
            threadKey,
        });
    } catch {
        // A failed summary is non-fatal — the answer is already persisted.
    }
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

/**
 * How long a parked run waits to be handed the thread before giving up.
 *
 * The wake event is sent from a durable step, so it survives ordinary failures;
 * the timeout covers the case it can never land — the finishing run's instance
 * was terminated after the handoff committed, or its binding was gone. Without
 * it a parked run hibernates forever holding a queue slot. Twelve hours is far
 * longer than any agent run and far shorter than "never".
 */
const DEQUEUE_TIMEOUT = "12 hours";

/**
 * Hibernate until this run is handed the thread it queued for.
 *
 * The match `type` is scoped to `(threadKey, instanceId)` for the same reason
 * the HITL approval scopes to a tool-call id: native CF Workflows matches a
 * waiter by `type`, so a shared type would let one parked run's wake resolve a
 * different one. A workflow replay memoizes the resolved wait, so a resumed run
 * does not park twice.
 */
const awaitDequeue = async (step: AgentStepLike, threadKey: string, instanceId: string): Promise<void> => {
    await step.waitForEvent<{ threadKey: string }>(`dequeue:${instanceId}`, {
        timeout: DEQUEUE_TIMEOUT,
        type: `agent-dequeue:${threadKey}:${instanceId}`,
    });
};

/**
 * Wake the run the completion mutation just handed the thread to.
 *
 * Wrapped in a durable step so a transient failure is retried rather than
 * stranding a run that already owns the thread; if it can never land, the
 * parked run's own {@link DEQUEUE_TIMEOUT} ends it instead of hibernating
 * forever. Best-effort by design — the ownership transfer already committed,
 * and re-running this mutation is not an option.
 */
const wakeDequeuedRun = async (
    deps: { env: Record<string, unknown>; exportName: string; step: AgentStepLike },
    threadKey: string,
    dequeuedInstanceId: string,
): Promise<void> => {
    const binding = deps.env[agentBindingName(deps.exportName)] as AgentWorkflowBindingLike | undefined;

    if (!binding || typeof binding.get !== "function") {
        return;
    }

    const get = binding.get.bind(binding);

    try {
        await deps.step.do(`dequeue-wake:${dequeuedInstanceId}`, async (): Promise<string> => {
            const instance = await get(dequeuedInstanceId);

            await instance.sendEvent({ payload: { threadKey }, type: `agent-dequeue:${threadKey}:${dequeuedInstanceId}` });

            return dequeuedInstanceId;
        });
    } catch {
        // The dequeued instance is gone (terminated while parked), or the send
        // kept failing. It owns the thread until its wait times out; a run that
        // starts after that finds an ownerless thread and proceeds normally.
    }
};

/**
 * Hand a triggered run's final answer to the agent's `onReply`.
 *
 * No-op unless the run carries a `replyRef` (an ordinary in-app run does not)
 * AND the agent declared `onReply`. Wrapped in a named durable step so the
 * delivery is retried on a transient provider failure and, under a workflow
 * replay, is served from the memo instead of sending the answer twice — the
 * same guarantee `onStepFinish` gets.
 *
 * A reply that keeps failing must not turn a completed run into a failed one:
 * the answer is already persisted on the thread, and re-running the loop to
 * retry a Slack post would re-run the model. The failure is swallowed after the
 * step's own retries, exactly as run-end memory extraction is.
 */
const deliverReply = async (
    agent: AgentDefinition,
    context: { env: Record<string, unknown>; params: AgentRunInput; step: AgentStepLike },
    result: AgentRunResult,
): Promise<void> => {
    const { onReply } = agent;
    const { replyRef } = context.params;

    if (onReply === undefined || replyRef === undefined) {
        return;
    }

    try {
        await context.step.do("agent:reply", async (): Promise<string> => {
            await onReply({ env: context.env, replyRef, result, threadKey: context.params.threadKey });

            return replyRef.channel;
        });
    } catch {
        // Delivery failed past its retries — the answer is on the thread either way.
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
 * @experimental
 */
const runAgentLoop = async (options: AgentLoopOptions): Promise<AgentRunResult> => {
    const { agent, compact, env, exportName, extractEpisode, extractGraph, generate, instanceId, onTokenDelta, params, paths, run, step, streamGenerate } =
        options;
    const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;
    const stopConditions = normalizeStopWhen(agent.stopWhen);

    const appendMessage = toFunctionReference(paths.appendMessage);
    const completeRun = toFunctionReference(paths.completeRun);
    const ensureThread = toFunctionReference(paths.ensureThread);
    const listMessages = toFunctionReference(paths.listMessages);
    const deleteMessageRef = toFunctionReference(paths.deleteMessage);
    const patchThread = toFunctionReference(paths.patchThread);
    const setStateRef = toFunctionReference(paths.setState);
    const stateRef = toFunctionReference(paths.state);

    const persist = async (message: Record<string, unknown>): Promise<void> => {
        await run(appendMessage, { threadKey: params.threadKey, ...message });
    };

    const patchThreadByKey = async (patch: Record<string, unknown>): Promise<void> => {
        await run(patchThread, { key: params.threadKey, ...patch });
    };

    const deleteMessageByKey = async (messageKey: string): Promise<void> => {
        await run(deleteMessageRef, { messageKey, threadKey: params.threadKey });
    };

    /** The user turn that opens the run. Runs after any queue wait, so a parked run appends only once it owns the thread. */
    const persistUserTurn = async (): Promise<void> => {
        await persist({ content: params.input, messageKey: `${instanceId}:user`, role: "user" });
    };

    /**
     * End the run: write the terminal status and, in the same mutation, hand the
     * thread to the next queued run. Only then is the dequeued run woken — it
     * already owns the thread by that point, so there is no window in which two
     * runs believe they may append.
     */
    const finishRun = async (patch: { error?: string; status: "error" | "idle"; usage?: AgentUsage }): Promise<void> => {
        const outcome = (await run(completeRun, { instanceId, key: params.threadKey, ...patch })) as { dequeued?: string } | undefined;

        if (outcome?.dequeued !== undefined) {
            await wakeDequeuedRun({ env, exportName, step }, params.threadKey, outcome.dequeued);
        }
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
    })) as EnsureThreadOutcome | undefined;

    // Replace policy: the thread has been taken over — terminate the run it was
    // taken from so it cannot resume and race on the shared seq counter.
    if (bootstrap?.outcome === "replaced") {
        await terminatePriorInstance(env, exportName, bootstrap.priorInstanceId);
    }

    // Memory step: dispatch the configured retrieval action once per run and
    // inject the assembled context into every turn's prompt.
    const memoryContext = await retrieveMemoryContext(agent, params.input, params.owner, paths, step, run);

    // Resolve the system prompt once per run. A dynamic `instructions` thunk is
    // pure (env + run params in, string out), so calling it at the top level is
    // replay-stable — the same context yields the same prompt on a resume.
    const instructions =
        typeof agent.instructions === "function" ? agent.instructions({ env, input: params.input, threadKey: params.threadKey }) : agent.instructions;

    const turnContext: TurnContext = {
        agent,
        compact,
        depth: normalizeDepth(params.depth),
        env,
        generate,
        getState,
        instanceId,
        instructions,
        listMessages,
        memoryContext,
        onTokenDelta,
        deleteMessage: deleteMessageByKey,
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
        // Queue policy: when this run was parked behind the one in flight,
        // hibernate until the finishing run's completion hands us the thread — by
        // which point we already own it, so the first append lands on the shared
        // seq counter with nobody else writing to it.
        //
        // INSIDE the try on purpose: `waitForEvent` throws when its timeout
        // elapses (a wake that could never land), and outside the try that throw
        // escaped without running `finishRun` — leaving this run's queue row
        // behind forever. Five of those exhaust the depth cap and every later
        // start on the thread is refused.
        if (bootstrap?.outcome === "queued") {
            await awaitDequeue(step, params.threadKey, instanceId);
        }

        await persistUserTurn();

        const { final, stoppedByCondition, turnsRun } = await runTurns(turnContext, maxTurns, stopConditions, usageBox);
        const usagePatch = usageBox.value === undefined ? {} : { usage: usageBox.value };

        // Run-end graph extraction (owner-scoped, best-effort). No-ops unless a
        // graph memory source, an `owner`, a final answer, and the seam are all
        // present — so a semantic-only or anonymous run is byte-identical.
        await extractGraphMemoryAtRunEnd({
            agent,
            env,
            extractGraph,
            finalText: final?.text,
            input: params.input,
            instanceId,
            owner: params.owner,
            paths,
            run,
            step,
        });

        // Run-end episode recording (owner-scoped, best-effort). No-ops unless an
        // episodic memory source, an `owner`, a final answer, and the seam are all
        // present — so a non-episodic or anonymous run is byte-identical.
        await extractEpisodeAtRunEnd({
            agent,
            env,
            extractEpisode,
            finalText: final?.text,
            input: params.input,
            instanceId,
            owner: params.owner,
            paths,
            run,
            step,
            threadKey: params.threadKey,
        });

        if (final) {
            // Answer where the question was asked, before the thread goes idle:
            // a triggered run that never replies looks, from the channel it came
            // from, exactly like one that never ran.
            await deliverReply(agent, { env, params, step }, { ...final, ...usagePatch });
            await finishRun({ status: "idle", ...usagePatch });

            return { ...final, ...usagePatch };
        }

        if (stoppedByCondition) {
            // A stop condition is a deliberate end, not a failure — leave the
            // thread idle so it can continue on the next run.
            await finishRun({ status: "idle", ...usagePatch });

            return { stopped: "stopCondition", turns: turnsRun, ...usagePatch };
        }

        await finishRun({ error: `agent stopped: maxTurns (${String(maxTurns)}) reached`, status: "error", ...usagePatch });

        return { stopped: "maxTurns", turns: maxTurns, ...usagePatch };
    } catch (error) {
        // Surface the failure on the thread (observers see status:"error"),
        // then rethrow so the workflow records/retries per its policy. A failed
        // run still hands the thread on: the next queued run is waiting for THIS
        // one to end, not for it to succeed.
        await finishRun({
            error: error instanceof Error ? error.message : String(error),
            status: "error",
            ...(usageBox.value === undefined ? {} : { usage: usageBox.value }),
        });

        throw error;
    }
};

export type { AgentLoopOptions };
export { compactHistory, runAgentLoop, splitForCompaction };
